export {};

declare global {
  interface ItsWebMcpTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
    execute: (input: Record<string, unknown>) => Promise<unknown> | unknown;
  }

  interface ItsModelContext {
    registerTool(tool: ItsWebMcpTool): Promise<void> | void;
    unregisterTool?: (name: string) => void;
  }

  interface Document {
    readonly modelContext?: ItsModelContext;
  }

  interface SubmitEvent {
    readonly agentInvoked?: boolean;
    respondWith?: (response: Promise<unknown> | unknown) => void;
  }
}
