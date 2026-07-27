import { modelCatalog } from "./ModelCatalog";

/** Public Hub discovery facade; the underlying catalog enforces ONNX/Transformers.js/license filters. */
export class HuggingFaceModelCatalog {
  discover = modelCatalog.discover.bind(modelCatalog);
}

export const huggingFaceModelCatalog = new HuggingFaceModelCatalog();
