/**
 * renderLoopWatch on its own: a widget whose `loop()` runs one frame the way
 * Cesium 1.141's default render loop does (CesiumWidget.js startRenderLoop:
 * resize() then render() in one try/catch; a throw switches the loop off).
 *
 * Pins: a throw that stops the loop is reported once, a microtask later,
 * with its error, and is thrown on unchanged; a resize() inside render()
 * (the floating window's lens crop) reports once, not twice; a throw from
 * outside the loop while it runs on, or while it is off (WebXR), is not a
 * stop; the remover puts the widget's own methods back (an own method it
 * had included) and leaves a method someone else installed since alone.
 */
import { describe, expect, it, vi } from 'vitest';
import { watchRenderLoop } from './renderLoopWatch';

class Widget {
  _useDefaultRenderLoop = true;
  frameBody: () => void = () => undefined;
  resizeBody: () => void = () => undefined;
  get useDefaultRenderLoop() {
    return this._useDefaultRenderLoop;
  }
  set useDefaultRenderLoop(on: boolean) {
    this._useDefaultRenderLoop = on;
  }
  render() {
    this.frameBody();
  }
  resize() {
    this.resizeBody();
  }
  /** One frame of the default loop; false when it is (or just went) off. */
  loop(): boolean {
    if (!this._useDefaultRenderLoop) return false;
    try {
      this.resize();
      this.render();
      return true;
    } catch {
      this._useDefaultRenderLoop = false;
      return false;
    }
  }
}

const microtasks = () => new Promise<void>((r) => setTimeout(r, 0));

describe('watchRenderLoop', () => {
  it('reports a throw that stops the loop once, a microtask later, with its error', async () => {
    const w = new Widget();
    const stopped = vi.fn();
    watchRenderLoop(w, stopped);
    expect(w.loop()).toBe(true);
    const error = new Error('preRender threw');
    w.frameBody = () => {
      throw error;
    };
    expect(w.loop()).toBe(false);
    expect(stopped, 'checked once the loop has caught it').not.toHaveBeenCalled();
    await microtasks();
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledWith(error);
  });

  it('throws the error on unchanged and calls the method on the receiver it was called on', () => {
    const w = new Widget();
    watchRenderLoop(w, () => undefined);
    const error = new Error('as is');
    w.frameBody = () => {
      throw error;
    };
    let caught: unknown;
    try {
      w.render();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(error);
    const seen: string[] = [];
    const other = new Widget();
    other.frameBody = () => seen.push('other');
    w.frameBody = () => seen.push('w');
    w.render.call(other);
    w.render();
    expect(seen).toEqual(['other', 'w']);
  });

  it('a resize() inside render() that throws reports once, not once per wrapper', async () => {
    const w = new Widget();
    const stopped = vi.fn();
    watchRenderLoop(w, stopped);
    // The loop's own resize() passes; the one render() makes (the lens crop) throws.
    w.frameBody = () => w.resize();
    let calls = 0;
    w.resizeBody = () => {
      calls++;
      if (calls > 1) throw new Error('lens crop resize');
    };
    expect(w.loop()).toBe(false);
    await microtasks();
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('a throw from outside the loop while it runs on is not a stop, and leaves the watch armed', async () => {
    const w = new Widget();
    const stopped = vi.fn();
    watchRenderLoop(w, stopped);
    w.resizeBody = () => {
      throw new Error('ResizeObserver');
    };
    expect(() => w.resize()).toThrow('ResizeObserver');
    await microtasks();
    expect(w.useDefaultRenderLoop).toBe(true);
    expect(stopped).not.toHaveBeenCalled();
    w.resizeBody = () => undefined;
    w.frameBody = () => {
      throw new Error('a real stop');
    };
    expect(w.loop()).toBe(false);
    await microtasks();
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('each stop of a restarted loop reports', async () => {
    const w = new Widget();
    const stopped = vi.fn();
    watchRenderLoop(w, stopped);
    w.frameBody = () => {
      throw new Error('stop');
    };
    expect(w.loop()).toBe(false);
    await microtasks();
    w.useDefaultRenderLoop = true;
    expect(w.loop()).toBe(false);
    await microtasks();
    expect(stopped).toHaveBeenCalledTimes(2);
  });

  it('the loop turned off on purpose (WebXR), and a throw while it is off, are not stops', async () => {
    const w = new Widget();
    const stopped = vi.fn();
    watchRenderLoop(w, stopped);
    w.useDefaultRenderLoop = false;
    expect(w.loop()).toBe(false);
    w.frameBody = () => {
      throw new Error('XR frame');
    };
    expect(() => w.render()).toThrow('XR frame');
    await microtasks();
    expect(stopped).not.toHaveBeenCalled();
  });

  it('the remover puts the prototype methods back, and a check still pending reports nothing', async () => {
    const w = new Widget();
    const stopped = vi.fn();
    const stop = watchRenderLoop(w, stopped);
    expect(Object.hasOwn(w, 'render')).toBe(true);
    expect(Object.hasOwn(w, 'resize')).toBe(true);
    w.frameBody = () => {
      throw new Error('last frame');
    };
    expect(w.loop()).toBe(false);
    stop();
    await microtasks();
    expect(stopped).not.toHaveBeenCalled();
    expect(Object.hasOwn(w, 'render')).toBe(false);
    expect(Object.hasOwn(w, 'resize')).toBe(false);
    expect(w.render).toBe(Widget.prototype.render);
  });

  it("puts back an own method the widget had, and leaves one installed since alone", () => {
    const w = new Widget();
    const ownRender = vi.fn();
    w.render = ownRender;
    const stop = watchRenderLoop(w, () => undefined);
    expect(w.render).not.toBe(ownRender);
    w.render();
    expect(ownRender).toHaveBeenCalledTimes(1);
    const later = vi.fn();
    w.resize = later;
    stop();
    expect(w.render).toBe(ownRender);
    expect(w.resize).toBe(later);
  });
});
