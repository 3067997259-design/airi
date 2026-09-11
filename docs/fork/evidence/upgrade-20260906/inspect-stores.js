(() => {
  const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
  const skills = stores.get('skills-review')
  const journal = stores.get('runtime-journal')
  const chat = stores.get('chat')
  return {
    skillCount: skills.queue.length,
    skills: skills.queue.map(entry => ({ toolId: entry.toolId, trust: entry.trust })),
    journalEvents: journal.events.length,
    flows: Object.values(chat.flowStates).map(flow => ({ status: flow.status })),
    storage: Object.keys(localStorage)
      .filter(key => key === 'skills/review-queue' || key.startsWith('settings/memory/') || key === 'airi-cards')
      .map(key => ({ key, bytes: new TextEncoder().encode(localStorage.getItem(key)).byteLength })),
  }
})()
