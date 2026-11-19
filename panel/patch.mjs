// Brings an element's children in line with an HTML string, touching only what differs. Elements
// that stay keep their scroll position and hover state, which replacing innerHTML would lose, and
// CSS transitions run on what changes in them. Children with a data-key are matched by it, wherever
// they stand, so that one going away leaves the others in place; an element with a key not seen
// before is something else, such as the list of another workspace, and shows without a transition.

function patchAttributes(from, to) {
  for (const { name } of [...from.attributes]) {
    if (!to.hasAttribute(name)) from.removeAttribute(name)
  }
  for (const { name, value } of [...to.attributes]) {
    if (from.getAttribute(name) !== value) from.setAttribute(name, value)
  }
}

function keyOf(node) {
  return node.nodeType === 1 ? node.getAttribute('data-key') : null
}

function isSameKind(from, to) {
  return from.nodeType === to.nodeType && from.nodeName === to.nodeName
}

function patchNodes(parent, wanted) {
  const keyed = new Map()
  for (const node of parent.childNodes) {
    const key = keyOf(node)
    if (key !== null && !keyed.has(key)) keyed.set(key, node)
  }
  wanted.forEach((to, index) => {
    // Everything before index is in its final place; what is left over after the loop goes.
    const at = parent.childNodes[index] ?? null
    const key = keyOf(to)
    const candidate = key === null ? at : keyed.get(key)
    // An unkeyed node never takes the place of a keyed one, which a later node may still claim.
    const from = candidate && keyOf(candidate) === key && isSameKind(candidate, to) ? candidate : null
    if (!from) {
      parent.insertBefore(to, at)
      return
    }
    if (key !== null) keyed.delete(key)
    if (from !== at) parent.insertBefore(from, at)
    if (from.nodeType === 1) {
      patchAttributes(from, to)
      patchNodes(from, [...to.childNodes])
    } else if (from.nodeValue !== to.nodeValue) {
      from.nodeValue = to.nodeValue
    }
  })
  for (const extra of [...parent.childNodes].slice(wanted.length)) parent.removeChild(extra)
}

export function patchChildren(element, html) {
  const template = element.ownerDocument.createElement('template')
  template.innerHTML = html
  patchNodes(element, [...template.content.childNodes])
}
