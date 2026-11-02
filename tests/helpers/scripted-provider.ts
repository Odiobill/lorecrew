import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
export { fauxAssistantMessage, fauxToolCall };
export function scriptedProvider(modelIds=['test-model']) {
  const faux = fauxProvider({provider:'scripted', models:modelIds.map(id=>({id,reasoning:true})), tokensPerSecond:Infinity});
  const models = createModels(); models.setProvider(faux.provider);
  return {models, faux};
}
