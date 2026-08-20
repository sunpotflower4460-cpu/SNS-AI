import { stageHubProduct } from './convenience-hub.mjs';
import { validateHubProductContract } from './product-contract.mjs';

export async function prepareHubPublish(product, options = {}) {
  validateHubProductContract(product, { requireReady: true });
  const staged = await stageHubProduct(product, options);
  return {
    staged,
    hub: {
      required: true,
      integration: 'convenience-discovery-v1',
      productId: product.productId,
      expectedContentVersion: staged.expectedContentVersion
    }
  };
}
