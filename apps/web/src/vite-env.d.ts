/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;

/** jscanify ships no types; the shape below matches src/jscanify.js (UMD, MIT © ColonelParrot). */
declare module 'jscanify/client' {
  export interface JScanifyCorner { x: number; y: number }
  export interface JScanifyCorners {
    topLeftCorner?: JScanifyCorner;
    topRightCorner?: JScanifyCorner;
    bottomLeftCorner?: JScanifyCorner;
    bottomRightCorner?: JScanifyCorner;
  }
  export default class JScanify {
    findPaperContour(img: unknown): unknown;
    getCornerPoints(contour: unknown): JScanifyCorners;
    highlightPaper(image: CanvasImageSource, options?: { color?: string; thickness?: number }): HTMLCanvasElement;
    extractPaper(
      image: CanvasImageSource, resultWidth: number, resultHeight: number, cornerPoints?: {
        topLeftCorner: JScanifyCorner; topRightCorner: JScanifyCorner;
        bottomLeftCorner: JScanifyCorner; bottomRightCorner: JScanifyCorner;
      },
    ): HTMLCanvasElement | null;
  }
}
