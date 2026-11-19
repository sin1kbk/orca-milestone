// Turns the focused workspace and the agent sessions found on disk into what the panel shows.

const MAX_SESSIONS = 3
const MAX_ROWS = 8

export function isInside(path, root) {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

function progress(tasks) {
  const visible = tasks.filter((task) => task.status !== 'deleted')
  const done = visible.filter((task) => task.status === 'completed').length
  return { done, total: visible.length, tasks: visible }
}

/**
 * Whether a session belongs to a workspace: by the pane it runs in when an Orca agent has that pane,
 * else by its folder. A pane keeps a session in a worktree nested inside another workspace's folder
 * apart from that workspace.
 * @param panes      the panes of the workspace's agents
 * @param knownPanes the panes of every agent Orca runs
 */
function belongsTo(session, path, panes, knownPanes) {
  if (session.paneKey && knownPanes.has(session.paneKey)) return panes.has(session.paneKey)
  return Boolean(session.cwd) && isInside(session.cwd, path)
}

function panesOf(agents) {
  return new Set(agents.map((agent) => agent.paneKey).filter(Boolean))
}

// An agent needs the user when it asks for input or for a permission.
const NEEDS_USER = new Set(['waiting', 'blocked', 'permission'])

/**
 * The other workspaces where Claude needs the user or has a task list, each with the progress
 * of its newest list. Lists only reach here while their session runs. The focused workspace is
 * shown in full above. Whether Claude is at work flips every turn, so it shows on a row but does
 * not decide which rows show or their order, which would make them jump.
 */
function buildOthers(agents, sessions) {
  const knownPanes = panesOf(agents)
  // Several live agents in one workspace get a row each; otherwise the workspace has one row.
  const live = new Map()
  for (const agent of agents) if (agent.live && agent.paneKey) live.set(agent.path, [...(live.get(agent.path) ?? []), agent])
  const byWorkspace = new Map()
  for (const agent of agents) {
    const split = (live.get(agent.path)?.length ?? 0) > 1
    if (split && !(agent.live && agent.paneKey)) continue
    const key = split ? `${agent.path}\n${agent.paneKey}` : agent.path
    const entry = byWorkspace.get(key) ?? { ...agent, title: split ? agent.title : null, panes: new Set(), needsUser: false, working: false, background: false, since: 0 }
    if (agent.paneKey) entry.panes.add(agent.paneKey)
    if (NEEDS_USER.has(agent.state)) {
      entry.needsUser = true
      entry.since = Math.max(entry.since, agent.since ?? 0)
    }
    if (agent.state === 'working') entry.working = true
    if (agent.background) entry.background = true
    byWorkspace.set(key, entry)
  }
  const rows = [...byWorkspace.values()].map((entry) => {
    const session = entry.title !== null
      ? sessions.find((s) => s.tasks.length > 0 && s.paneKey === entry.paneKey)
      : sessions.find((s) => s.tasks.length > 0 && belongsTo(s, entry.path, entry.panes, knownPanes))
    const counts = session ? progress(session.tasks) : { done: 0, total: 0, tasks: [] }
    return {
      workspace: entry.workspace,
      path: entry.path,
      paneKey: entry.title !== null ? entry.paneKey : null,
      title: entry.title,
      repo: entry.repo ?? null,
      focused: entry.focused,
      kind: entry.needsUser ? 'attention' : 'idle',
      working: entry.working && !entry.needsUser,
      background: entry.background && !entry.working && !entry.needsUser,
      since: entry.since,
      updatedAt: session?.updatedAt ?? 0,
      goal: session?.goal ?? null,
      ...counts
    }
  })
  const rank = (row) =>
    row.kind === 'attention' ? 0 : row.done < row.total ? 1 : 2
  return {
    attention: rows.filter((row) => row.kind === 'attention').length,
    // Those needing the user first, longest waiting first; then unfinished and then finished
    // lists, most recently updated first.
    rows: rows
      .filter(
        (row) =>
          !row.focused &&
          (row.kind === 'attention' || row.total > 0)
      )
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          (a.kind === 'attention' ? a.since - b.since : b.updatedAt - a.updatedAt)
      )
      .slice(0, MAX_ROWS)
  }
}

/**
 * @param workspace { path, displayName, agentStates, background, agents } of the focused workspace, or null;
 *   `agents` are its live agents, [{ paneKey, title, state, background }]
 * @param sessions  [{ listId, cwd, paneKey, goal, tasks, updatedAt }] of every workspace, newest first
 * @param agents    [{ workspace, repo, path, paneKey, title, live, focused, state, background, since }] Orca runs, one per Claude or Codex agent
 * @param offers    [{ kind, id, path, ... }] what agents offer to choose from, see next-actions.mjs
 */
export function buildModel(workspace, sessions, agents = [], offers = []) {
  const others = buildOthers(agents, sessions)
  if (!workspace) return { kind: 'no-workspace', others }
  const panes = new Set([...panesOf(agents.filter((agent) => agent.path === workspace.path)), ...panesOf(workspace.agents ?? [])])
  const knownPanes = new Set([...panesOf(agents), ...panes])
  const mine = sessions
    .filter((session) => session.tasks.length > 0 && belongsTo(session, workspace.path, panes, knownPanes))
    .map((session) => ({ listId: session.listId, paneKey: session.paneKey ?? null, goal: session.goal, ...progress(session.tasks) }))
  const shown = (list) => list.slice(0, MAX_SESSIONS).map(({ paneKey, ...session }) => session)
  const model = {
    workspace: workspace.displayName,
    agent: agentLabel(workspace.agentStates ?? [], workspace.background),
    others
  }
  const live = (workspace.agents ?? []).filter((agent) => agent.paneKey)
  if (live.length <= 1) {
    return {
      ...model,
      kind: mine.length > 0 ? 'sessions' : 'no-tasks',
      sessions: shown(mine),
      next: offers.find((offer) => offer.path === workspace.path) ?? null
    }
  }
  // Several agents in the workspace: each shows its own tasks and offers, under its own name.
  return {
    ...model,
    kind: 'agents',
    agents: live.map((agent) => ({
      paneKey: agent.paneKey,
      title: agent.title,
      agent: agentLabel([agent.state], agent.background),
      sessions: shown(mine.filter((session) => session.paneKey === agent.paneKey)),
      next: offers.find((offer) => offer.paneKey === agent.paneKey) ?? null
    })),
    // Sessions in the folder that no agent's pane runs, such as one started outside Orca.
    sessions: shown(mine.filter((session) => !live.some((agent) => agent.paneKey === session.paneKey)))
  }
}

function agentLabel(states, background) {
  if (states.includes('working')) return 'working'
  if (states.includes('blocked') || states.includes('waiting')) return 'waiting'
  return states.length > 0 ? (background ? 'background' : 'idle') : 'none'
}
