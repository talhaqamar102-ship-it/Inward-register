import type { RenderAppOptions } from './utils/domModalsAndPrint';

type RendererFn = (options?: RenderAppOptions) => void;

let renderer: RendererFn = () => {};

export function setRenderer(fn: RendererFn): void {
  renderer = fn;
}

export function renderApp(options?: RenderAppOptions): void {
  renderer(options);
}
