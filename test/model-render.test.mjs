import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildModel, isInside } from '../src/model.mjs'
import { renderBody } from '../src/render.mjs'
import { task } from './helpers.mjs'

const workspace = { path: '/work/app', displayName: 'app', agentStates: ['working'] }

test('isInside matches the root and its subfolders only', () => {
  assert.ok(isInside('/work/app', '/work/app'))
  assert.ok(isInside('/work/app/pkg', '/work/app'))
  assert.ok(!isInside('/work/app-2', '/work/app'))
})

test('buildModel keeps sessions with tasks inside the focused workspace', () => {
  const model = buildModel(workspace, [
    { listId: 'a', cwd: '/work/app/pkg', goal: 'Goal A', tasks: [task(1, 'x', 'completed'), task(2, 'y', 'pending')] },
    { listId: 'b', cwd: '/work/other', goal: 'Goal B', tasks: [task(1, 'z', 'pending')] },
    { listId: 'c', cwd: '/work/app', goal: 'Goal C', tasks: [] }
  ])
  assert.equal(model.kind, 'sessions')
  assert.equal(model.agent, 'working')
  assert.deepEqual(
    model.sessions.map((s) => [s.listId, s.done, s.total]),
    [['a', 1, 2]]
  )
})

test('buildModel reports no workspace and no tasks', () => {
  assert.equal(buildModel(null, []).kind, 'no-workspace')
  const model = buildModel({ ...workspace, agentStates: [] }, [])
  assert.equal(model.kind, 'no-tasks')
  assert.equal(model.agent, 'none')
})

test('renderBody escapes text, shows progress and is deterministic', () => {
  const model = buildModel(workspace, [
    {
      listId: 'a',
      cwd: '/work/app',
      goal: 'Fix <script> injection',
      tasks: [task(1, 'Read spec', 'completed'), task(2, 'Write code', 'in_progress', { activeForm: 'Writing code' }), task(3, 'Run tests', 'pending')]
    }
  ])
  const html = renderBody(model)
  assert.ok(html.includes('Fix &lt;script&gt; injection'))
  assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('1 / 3'))
  assert.ok(html.includes('width:33%'))
  assert.ok(html.includes('Writing code'))
  assert.ok(html.includes('作業中'))
  assert.equal(renderBody(model), html)
})

test('other workspaces list those needing the user first, then unfinished and finished lists', () => {
  const agent = (name, state, since, extra = {}) => ({ workspace: name, repo: 'repo-x', path: `/work/${name}`, focused: false, state, since, ...extra })
  const list = (name, done, total, updatedAt, running = false) => ({
    listId: name,
    cwd: `/work/${name}/pkg`,
    goal: `Goal ${name}`,
    updatedAt,
    tasks: Array.from({ length: total }, (_, i) => task(i + 1, `t${i}`, i < done ? 'completed' : running && i === done ? 'in_progress' : 'pending'))
  })
  const lists = [list('question', 1, 2, 50), list('older', 0, 1, 10), list('newer', 2, 3, 40, true), list('finished', 1, 1, 60)]
  const model = buildModel(workspace, lists, [
    agent('question', 'waiting', 1),
    agent('question', 'working', 2),
    agent('allow', 'blocked', 5),
    agent('older', 'done', 9),
    agent('newer', 'working', 8),
    agent('finished', 'done', 8),
    agent('busy', 'working', 7),
    agent('app', 'waiting', 6, { focused: true })
  ])
  assert.equal(model.others.attention, 3)
  assert.deepEqual(
    model.others.rows.map((row) => [row.workspace, row.kind, row.done, row.total]),
    [
      ['question', 'attention', 1, 2],
      ['allow', 'attention', 0, 0],
      ['newer', 'idle', 2, 3],
      ['older', 'idle', 0, 1],
      ['finished', 'idle', 1, 1]
    ]
  )

  const html = renderBody(model)
  assert.ok(html.includes('ほかのワークスペース'))
  assert.ok(html.includes('要確認 3'))
  assert.equal(html.match(/class="badge"/g).length, 2)
  assert.ok(html.includes('width:67%'))
  assert.ok(!html.includes('busy'))
  // Only the finished row gets a check; the others keep a dot.
  assert.equal(html.match(/<span class="check">✓<\/span><span class="name">finished/g).length, 1)
  assert.equal(html.match(/class="check"/g).length, 1)
  // Only the row with a task in progress gets the orange dot.
  assert.equal(html.match(/<span class="dot running"><\/span><span class="name">newer/g).length, 1)
  assert.equal(html.match(/class="dot running"/g).length, 1)
  assert.ok(html.includes('<span class="name">question<span class="repo">repo-x</span></span>'))
  // Every row, with a list or without, opens its workspace; the path is escaped into the attribute.
  assert.equal(html.match(/role="button"/g).length, 5)
  assert.ok(html.includes('data-open="/work/allow"'))
  assert.ok(renderBody(buildModel(workspace, [], [agent('a"b', 'waiting', 1)])).includes('data-open="/work/a&quot;b"'))
  // Rows with tasks expand to their goal and tasks on hover; rows without have nothing to expand.
  assert.equal(html.match(/<div class="detail">/g).length, 4)
  assert.ok(html.includes('<div class="detail"><div class="inner"><p class="goal">Goal question</p><ol>'))
  assert.ok(html.includes('<p class="goal">Goal question</p>'))
  assert.ok(!html.includes('CLAUDE_CODE_ENABLE_TODO_TOOLS'))
  // At work: only the row with an agent working that needs nothing from the user.
  assert.deepEqual(model.others.rows.filter((row) => row.working).map((row) => row.workspace), ['newer'])
  assert.equal(html.match(/<span class="working">作業中<\/span>/g).length, 1)
  assert.equal(renderBody(model), html)
})

test('a list keeps its key while its tasks progress, and gets another with a new goal', () => {
  const keyOf = (html) => html.match(/<section data-key="([^"]*)"/)[1]
  const render = (goal, status) =>
    renderBody(buildModel(workspace, [{ listId: 'a', cwd: '/work/app', goal, tasks: [task(1, 'x', status)] }]))
  assert.equal(keyOf(render('Goal', 'pending')), keyOf(render('Goal', 'completed')))
  assert.notEqual(keyOf(render('Goal', 'pending')), keyOf(render('Other goal', 'pending')))
  assert.ok(render('"quoted" <goal>', 'pending').includes('&quot;quoted&quot; &lt;goal&gt;'))
})

test('an expanded row shows every task, and only a long list lets the pointer in', () => {
  const row = (count) => renderBody(buildModel(workspace, [
    { listId: 'x', cwd: '/work/x', goal: 'G', updatedAt: 1, tasks: Array.from({ length: count }, (_, i) => task(i + 1, `t${i}.`, 'completed')) }
  ], [{ workspace: 'x', path: '/work/x', focused: false, state: 'working', since: 1 }]))
  assert.ok(row(8).includes('t7.'))
  assert.ok(!row(8).includes('has-detail long'))
  assert.ok(row(40).includes('t39.'))
  assert.ok(row(40).includes('has-detail long'))
})

test('an agent waiting while its shells run in the background says so, here and on its row', () => {
  const tasks = [task(1, 'Run it', 'pending')]
  const focused = buildModel({ ...workspace, agentStates: ['done'], background: true }, [{ listId: 'l', cwd: '/work/app', goal: 'g', tasks }])
  assert.equal(focused.agent, 'background')
  assert.ok(renderBody(focused).includes('<span class="agent background">待機中（裏で実行中）</span>'))
  assert.equal(buildModel({ ...workspace, agentStates: ['done'] }, []).agent, 'idle')
  const other = { workspace: 'juiz', repo: null, path: '/work/juiz', focused: false, state: 'done', background: true, since: 1 }
  const model = buildModel(workspace, [{ listId: 'j', cwd: '/work/juiz', goal: 'g', tasks }], [other])
  assert.equal(model.others.rows[0].background, true)
  assert.ok(renderBody(model).includes('<span class="background">裏で実行中</span>'))
})

test('several agents in the focused workspace each show their own tasks and offer, under their own name', () => {
  const agents = [
    { paneKey: 'tab:a', title: 'UI を直す', state: 'working', background: false },
    { paneKey: 'tab:b', title: 'テストを書く', state: 'done', background: false }
  ]
  const sessions = [
    { listId: 'a', cwd: '/work/app', paneKey: 'tab:a', goal: 'Goal A', tasks: [task(1, 'x', 'in_progress')] },
    { listId: 'b', cwd: '/work/app', paneKey: 'tab:b', goal: 'Goal B', tasks: [task(1, 'y', 'completed')] }
  ]
  const offer = { kind: 'proposal', id: 'o1', path: '/work/app', paneKey: 'tab:b', suggestions: [{ label: 'PR', prompt: 'p', reason: '' }] }
  const model = buildModel({ ...workspace, agentStates: ['working', 'done'], agents }, sessions, [], [offer])
  assert.equal(model.kind, 'agents')
  assert.deepEqual(model.agents.map((a) => [a.title, a.agent, a.sessions.map((s) => s.listId), a.next?.id ?? null]), [
    ['UI を直す', 'working', ['a'], null],
    ['テストを書く', 'idle', ['b'], 'o1']
  ])
  const html = renderBody(model)
  assert.ok(html.indexOf('UI を直す') < html.indexOf('Goal A') && html.indexOf('Goal A') < html.indexOf('テストを書く'))
  assert.ok(html.indexOf('テストを書く') < html.indexOf('data-next="o1"'), 'the offer sits with its own agent')
  // One agent keeps the plain layout.
  assert.equal(buildModel({ ...workspace, agents: agents.slice(0, 1) }, sessions).kind, 'sessions')
})

test('another workspace with several agents gets a row for each, with that agent progress', () => {
  const agent = (paneKey, title, state, extra = {}) => ({ workspace: 'juiz', repo: null, path: '/work/juiz', paneKey, title, live: true, focused: false, state, background: false, since: 1, ...extra })
  const sessions = [
    { listId: 'a', cwd: '/work/juiz', paneKey: 'tab:a', goal: 'Goal A', updatedAt: 2, tasks: [task(1, 'x', 'completed'), task(2, 'y', 'pending')] },
    { listId: 'b', cwd: '/work/juiz', paneKey: 'tab:b', goal: 'Goal B', updatedAt: 1, tasks: [task(1, 'z', 'completed')] }
  ]
  const closed = agent('tab:old', 'old', 'waiting', { live: false })
  const { others } = buildModel(workspace, sessions, [agent('tab:a', 'UI を直す', 'working'), agent('tab:b', 'テストを書く', 'done'), closed])
  assert.deepEqual(others.rows.map((row) => [row.title, row.goal, row.done, row.total]), [
    ['UI を直す', 'Goal A', 1, 2],
    ['テストを書く', 'Goal B', 1, 1]
  ])
  assert.ok(renderBody(buildModel(workspace, sessions, [agent('tab:a', 'UI を直す', 'working'), agent('tab:b', 'テストを書く', 'done')])).includes('<span class="title">UI を直す</span>'))
})

test('a session in the pane of a nested workspace agent is not shown under the outer workspace', () => {
  const agent = (path, paneKey) => ({ workspace: path, repo: null, path, paneKey, title: null, live: true, focused: false, state: 'working', background: false, since: 1 })
  const sessions = [{ listId: 'n', cwd: '/work/app/.claude/worktrees/x', paneKey: 'tab:x', goal: 'Nested', updatedAt: 1, tasks: [task(1, 'x', 'pending')] }]
  const model = buildModel({ ...workspace, agents: [{ paneKey: 'tab:app' }] }, sessions, [agent('/work/app', 'tab:app'), agent('/work/app/.claude/worktrees/x', 'tab:x')])
  assert.equal(model.kind, 'no-tasks')
  assert.equal(model.others.rows.length, 1)
  assert.equal(model.others.rows[0].path, '/work/app/.claude/worktrees/x')
})
