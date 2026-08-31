import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed } from 'vue'

/**
 * GitHub babysitter configuration (COMMAND-PLAN follow-up: repo watch).
 *
 * Values ride localStorage so the settings page and the tool family share
 * them without a main-process round trip. The PAT never leaves the renderer
 * except as an Authorization header to api.github.com. Without a token the
 * tools stay read-only at the unauthenticated rate limit (60 requests/hour).
 */
export const useGithubConfigStore = defineStore('github-config', () => {
  const pat = useLocalStorage('settings/github/pat', '')
  const repo = useLocalStorage('settings/github/repo', '3067997259-design/airi')

  const configured = computed(() => repo.value.trim().includes('/'))

  return { pat, repo, configured }
})
