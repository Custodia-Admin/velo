/**
 * Says when Cesium's default render loop has stopped on a throw.
 *
 * The loop (CesiumWidget's startRenderLoop) calls the widget's `resize()`
 * and `render()` every frame inside one try/catch. A throw that escapes
 * them switches the loop off for good, and Cesium says so only with its own
 * error panel (`showRenderLoopErrors`, off in the ride view). Its
 * `scene.renderError` event carries just what Scene's own tryAndCatchError
 * catches (the update and draw passes). Throws from the scene's preUpdate,
 * postUpdate, preRender and postRender listeners, from `clock.onTick`, from
 * `initializeFrame()` and from `resize()` skip it (Cesium 1.141), and the
 * ride's per-frame code runs in those listeners.
 *
 * `watchRenderLoop` wraps the widget instance's `render` and `resize` (the
 * loop looks both up on the instance every frame) and calls
 * `stopped(error)` when a throw out of them has switched the loop off: the
 * loop was on at the throw and is off once the loop's catch has run, a
 * microtask later. The error is thrown on unchanged. Not a stop:
 * - a throw from a caller outside the loop (a ResizeObserver calling
 *   `viewer.resize()`) while the loop keeps going;
 * - WebXR turning the loop off on purpose (lib/webxr): a turned-off loop
 *   calls neither method, and a throw while it is off is not its stop.
 * The returned function puts the widget's own methods back; call it before
 * the widget is destroyed.
 */

/** What Cesium's default render loop calls on a CesiumWidget each frame. */
export interface RenderLoopWidget {
  render(): void;
  resize(): void;
  readonly useDefaultRenderLoop: boolean;
}

const LOOP_METHODS = ['render', 'resize'] as const;

export function watchRenderLoop(widget: RenderLoopWidget, stopped: (error: unknown) => void): () => void {
  let watching = true;
  // One check per throw: a resize() inside render() (the floating window's
  // lens crop) unwinds through both wrappers with the same error.
  let checkPending = false;
  const checkStopped = (error: unknown) => {
    if (checkPending) return;
    checkPending = true;
    queueMicrotask(() => {
      checkPending = false;
      if (watching && !widget.useDefaultRenderLoop) stopped(error);
    });
  };
  const restore: Array<() => void> = [];
  for (const name of LOOP_METHODS) {
    const own = Object.getOwnPropertyDescriptor(widget, name);
    const original = widget[name];
    const guarded = function (this: unknown, ...args: unknown[]) {
      try {
        return Reflect.apply(original, this, args) as void;
      } catch (error) {
        if (widget.useDefaultRenderLoop) checkStopped(error);
        throw error;
      }
    };
    Object.defineProperty(widget, name, { configurable: true, enumerable: true, writable: true, value: guarded });
    restore.push(() => {
      if (widget[name] !== guarded) return;
      if (own) Object.defineProperty(widget, name, own);
      else Reflect.deleteProperty(widget, name);
    });
  }
  return () => {
    watching = false;
    for (const put of restore) put();
  };
}
