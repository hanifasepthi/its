import { localModelClient, type LocalModelResult } from "./LocalModelClient";
import type { ModelGenerationOptions, ModelMessage, ModelSelection } from "./ModelTaskTypes";

/** Worker-backed execution boundary. Model inference never runs on the map/UI thread. */
export class ModelWorker {
  generate(selection: ModelSelection, messages: ModelMessage[], options: ModelGenerationOptions = {}): Promise<LocalModelResult> {
    return localModelClient.generate(selection, messages, options);
  }

  dispose(): void {
    localModelClient.dispose();
  }
}

export const modelWorker = new ModelWorker();
