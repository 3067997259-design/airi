import type { TriggerPanelProvider } from './use-trigger-panel'

interface ReviewedSkill {
  toolId: string
  name: string
  description: string
}

/** Creates the `/` provider with built-in commands before reviewed skills. */
export function createSlashTriggerProvider(
  getSkills: () => ReviewedSkill[],
  translate: (key: string) => string,
): TriggerPanelProvider {
  return {
    trigger: '/',
    tokenCharacters: '[\\w-]',
    async getSections(query) {
      const needle = query.toLocaleLowerCase()
      const commands = ['plan', 'goal'].map(name => ({
        id: `command:${name}`,
        label: `/${name}`,
        description: translate(`stage.command.${name}.description`),
        replacement: `/${name} `,
        badge: translate('stage.command.badge'),
      })).filter(item => `${item.label} ${item.description}`.toLocaleLowerCase().includes(needle))
      const skills = getSkills()
        .filter(skill => [skill.name, skill.description, skill.toolId].some(field => field.toLocaleLowerCase().includes(needle)))
        .map(skill => ({
          id: `skill:${skill.toolId}`,
          label: skill.name,
          description: skill.description,
          replacement: `/${skill.name} `,
        }))

      return [
        { id: 'commands', label: translate('stage.command.section'), items: commands },
        { id: 'skills', label: translate('stage.skill-shelf.section'), items: skills },
      ]
    },
  }
}
