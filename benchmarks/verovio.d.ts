declare module "verovio/wasm" {
  type VerovioModuleFactory = () => Promise<unknown>;
  const createVerovioModule: VerovioModuleFactory;
  export default createVerovioModule;
}

declare module "verovio/esm" {
  export class VerovioToolkit {
    constructor(module: unknown);
    setOptions(options: Record<string, number>): void;
    loadData(data: string): boolean;
    renderToSVG(page: number, options?: Record<string, unknown>): string;
  }
}
