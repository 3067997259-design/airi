import embedWorkerURL from '@xsai-transformers/embed/worker?worker&url'

import { createEmbedProvider } from '@xsai-transformers/embed'
import { embed } from '@xsai/embed'

const provider = createEmbedProvider({
  baseURL: `xsai-transformers:///?worker-url=${embedWorkerURL}`,
})

let modelLoadPromise: Promise<void> | undefined

/** Creates a local 768-dimensional memory embedding with the installed worker provider. */
export async function embedMemoryText(text: string): Promise<number[]> {
  modelLoadPromise ??= provider.loadEmbed('Xenova/nomic-embed-text-v1')
  await modelLoadPromise

  const result = await embed({
    ...provider.embed('Xenova/nomic-embed-text-v1'),
    input: text,
  })
  return result.embedding
}
