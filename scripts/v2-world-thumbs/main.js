// Thumbnail renderer entry: ?view=<id>[&w=&h=&ss=] renders one still of the
// Perugia world bundle and sets window.__thumbDone = true.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { loadWorld, routeAt } from './world.js';
import { rasterLevel, maskSampler, makeWildLayer } from './ground.js';
import { MOODS, sunDirection, makeSkyMaterial, atmoUniforms } from './atmosphere.js';
import { buildTerrainGeometry, buildApronGeometry, makeGroundMaterial, levelTextures, heightTexture } from './terrain.js';
import { collectTrees, buildTreeMeshes, makeTreeMaterial } from './vegetation.js';
import { buildBuildings, makeBuildingMaterial } from './buildings.js';
import { buildRider } from './rider.js';

const log = (...a) => { console.log('[thumb]', ...a); (window.__thumbLog ??= []).push(a.join(' ')); };
const t0 = performance.now();
const lap = (what) => log(what, Math.round(performance.now() - t0), 'ms');

async function main() {
  const q = new URLSearchParams(location.search);
  const views = await (await fetch('./views.json')).json();
  const view = views.find((v) => v.id === q.get('view')) ?? views[0];
  const W = Number(q.get('w') ?? view.width), H = Number(q.get('h') ?? view.height);
  const SS = Number(q.get('ss') ?? 2);
  const mood = { ...MOODS[q.get('mood') ?? view.mood], ...(view.moodOverrides ?? {}) };
  const world = await loadWorld(q.get('world') ?? '../worlds/perugia/');
  const hf = world.hf;
  lap('loaded');

  // ---------------- camera ----------------
  const cam = new THREE.PerspectiveCamera(view.fov ?? 45, W / H, view.camera.type === 'chase' ? 0.15 : 2, 260000);
  let rider = null;
  const c = view.camera;
  const toThree = (x, y, h) => new THREE.Vector3(x, h, -y);
  let camW, lookW;
  const routeById = (id) => world.routes.find((r) => r.id === id);
  // from/to may be {route, s, side, up}: a point beside a route (side = metres to the left)
  const resolvePt = (pt) => {
    if (Array.isArray(pt)) return pt;
    const p = routeAt(routeById(pt.route), pt.s);
    return [p.x - p.dy * (pt.side ?? 0) + p.dx * (pt.fwd ?? 0), p.y + p.dx * (pt.side ?? 0) + p.dy * (pt.fwd ?? 0), pt.up ?? 0];
  };
  if (c.type === 'look') {
    c.from = resolvePt(c.from); c.to = resolvePt(c.to);
    const fh = c.fromAbs ? c.from[2] : hf.sample(c.from[0], c.from[1]) + c.from[2];
    const th = c.toAbs ? c.to[2] : hf.sample(c.to[0], c.to[1]) + (c.to[2] ?? 0);
    camW = [c.from[0], c.from[1], fh]; lookW = [c.to[0], c.to[1], th];
  } else if (c.type === 'route') {
    const route = world.routes.find((r) => r.id === c.route);
    const p = routeAt(route, c.s);
    const nx = -p.dy, ny = p.dx; // left normal
    const x = p.x - p.dx * (c.back ?? 0) + nx * (c.side ?? 0), y = p.y - p.dy * (c.back ?? 0) + ny * (c.side ?? 0);
    const a = routeAt(route, Math.min(route.lengthM - 1, c.s + (c.ahead ?? 400)));
    const yaw = ((c.yaw ?? 0) * Math.PI) / 180;
    let tx = a.x + nx * (c.aheadSide ?? 0), ty = a.y + ny * (c.aheadSide ?? 0);
    if (yaw) { const dx = tx - x, dy = ty - y; tx = x + dx * Math.cos(yaw) - dy * Math.sin(yaw); ty = y + dx * Math.sin(yaw) + dy * Math.cos(yaw); }
    camW = [x, y, hf.sample(x, y) + c.height];
    lookW = [tx, ty, hf.sample(tx, ty) + (c.lookHeight ?? 0)];
  } else if (c.type === 'chase') {
    // camera on the rider's straight-line tangent so the rider stays centred on curves
    const route = routeById(c.route);
    const rp = routeAt(route, c.s);
    const rh = hf.sample(rp.x, rp.y);
    const cx = rp.x - rp.dx * c.back - rp.dy * (c.side ?? 0), cy = rp.y - rp.dy * c.back + rp.dx * (c.side ?? 0);
    const ax = rp.x + rp.dx * (c.ahead ?? 40), ay = rp.y + rp.dy * (c.ahead ?? 40);
    camW = [cx, cy, Math.max(hf.sample(cx, cy), rh) + c.up];
    lookW = [ax, ay, rh + (c.lookHeight ?? 0)];
    rider = { x: rp.x, y: rp.y, h: rh, dx: rp.dx, dy: rp.dy };
  }
  if (view.rider) {
    const rp = routeAt(routeById(view.rider.route), view.rider.s);
    const x = rp.x - rp.dy * (view.rider.side ?? 0), y = rp.y + rp.dx * (view.rider.side ?? 0);
    rider = { x, y, h: hf.sample(x, y), dx: rp.dx, dy: rp.dy };
  }
  cam.position.copy(toThree(...camW));
  cam.lookAt(toThree(...lookW));
  if (c.roll) cam.rotateZ((c.roll * Math.PI) / 180);
  // shift the projection centre (screen fractions) to place the subject off-centre without re-aiming
  if (c.shiftX || c.shiftY) cam.setViewOffset(W, H, (c.shiftX ?? 0) * W, (c.shiftY ?? 0) * H, W, H);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  const fwd = new THREE.Vector3(); cam.getWorldDirection(fwd);
  const fwdXY = new THREE.Vector2(fwd.x, -fwd.z).normalize();
  log('camera', camW.map(Math.round).join(','), '->', lookW.map(Math.round).join(','));

  // ---------------- renderer ----------------
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(W * SS, H * SS, false);
  renderer.toneMapping = mood.agx ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = mood.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // ---------------- sky + environment ----------------
  const sunDir = sunDirection(mood);
  const skyMat = makeSkyMaterial(mood, sunDir);
  const skyScene = new THREE.Scene();
  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), skyMat);
  skyMesh.scale.setScalar(200000);
  skyMesh.frustumCulled = false;
  skyScene.add(skyMesh);
  skyMesh.position.copy(cam.position);
  const cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const cubeCam = new THREE.CubeCamera(1, 300000, cubeRT);
  cubeCam.position.copy(cam.position);
  cubeCam.update(renderer, skyScene);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromCubemap(cubeRT.texture).texture;

  const U = atmoUniforms();
  U.uSkyCube.value = cubeRT.texture;
  U.uSunDir.value.copy(sunDir);
  U.uHaze.value = mood.haze;
  U.uFogDensity.value = mood.fogDensity;
  U.uFogFalloff.value = mood.fogFalloff;
  U.uFogBase.value = mood.fogBase;
  U.uFogTint.value.set(mood.fogTint);
  U.uFogTintMix.value = mood.fogTintMix;
  U.uViewInv.value.copy(cam.matrixWorld);
  U.uHeightTex.value = heightTexture(hf);
  U.uHfBox.value.set(hf.xMin, hf.yMax, hf.cell, 0);
  U.uHfSize.value.set(hf.cols, hf.rows);
  U.uSunShadow.value = sunDir.y > 0 ? 1 : 0;
  U.uNight.value = mood.night;
  U.uSunCol.value.set(mood.sunColor).multiplyScalar(mood.sun / 4);
  U.uSunHaze.value = mood.sunHaze ?? 0;
  U.uHazeTint.value.set(mood.hazeTint ?? '#ffffff');
  U.uHazeG.value = mood.hazeG ?? 0.75;
  lap('sky');

  // ---------------- ground textures ----------------
  const wild = makeWildLayer(hf);
  lap('wild');
  const routesToPaint = world.routes;
  const levelsRaw = [];
  const l0w = 8192, l0h = Math.round(8192 * (hf.yMax - hf.yMin) / (hf.xMax - hf.xMin));
  levelsRaw.push(rasterLevel(world, { x0: hf.xMin, y0: hf.yMin, x1: hf.xMax, y1: hf.yMax }, l0w, l0h, { wild, routes: routesToPaint }));
  const boxAhead = (size, backFrac) => {
    const cx = camW[0] + fwdXY.x * size * (0.5 - backFrac), cy = camW[1] + fwdXY.y * size * (0.5 - backFrac);
    return { x0: cx - size / 2, y0: cy - size / 2, x1: cx + size / 2, y1: cy + size / 2 };
  };
  const l1 = view.l1 ?? (c.type === 'chase' ? 2400 : 4200);
  levelsRaw.push(rasterLevel(world, boxAhead(l1, 0.12), 4096, 4096, { wild, routes: routesToPaint }));
  const l2 = view.l2 ?? (c.type === 'chase' ? 420 : 900);
  levelsRaw.push(rasterLevel(world, boxAhead(l2, 0.15), 4096, 4096, { wild, routes: routesToPaint }));
  lap('raster');
  const samplers = levelsRaw.map(maskSampler);
  const sampleMask = (x, y) => samplers[1](x, y) ?? samplers[0](x, y);
  const levels = levelsRaw.map((L) => levelTextures(L, renderer));

  // ---------------- scene ----------------
  const scene = new THREE.Scene();
  const groundMat = makeGroundMaterial(U, levels, envMap);
  const terrain = new THREE.Mesh(buildTerrainGeometry(hf), groundMat);
  terrain.receiveShadow = true;
  terrain.frustumCulled = false;
  scene.add(terrain);
  const apron = new THREE.Mesh(buildApronGeometry(hf), groundMat);
  apron.frustumCulled = false;
  apron.receiveShadow = true;
  scene.add(apron);
  lap('terrain');

  const camPt = { x: camW[0], y: camW[1], h: camW[2] };
  const vis = (x, y) => { const v = new THREE.Vector3(x, hf.sample(x, y) + 5, -y); return frustum.intersectsSphere(new THREE.Sphere(v, 60)); };
  const bGeo = buildBuildings(world, hf, camPt.x, camPt.y, view.buildingR ?? 16000, vis);
  const bMesh = new THREE.Mesh(bGeo, makeBuildingMaterial(U, envMap));
  bMesh.castShadow = true; bMesh.receiveShadow = true; bMesh.frustumCulled = false;
  scene.add(bMesh);
  lap('buildings ' + bGeo.userData.count);

  // sunGap: keep a clearing between the rider and the low sun so the rider is sunlit
  let exclude = null;
  if (rider && view.sunGap) {
    const sx = sunDir.x, sy = -sunDir.z, sl = Math.hypot(sx, sy) || 1;
    const ux = sx / sl, uy = sy / sl;
    const { width = 14, length = 260 } = view.sunGap;
    exclude = (x, y) => {
      const dx = x - rider.x, dy = y - rider.y;
      const along = dx * ux + dy * uy;
      if (along < -4 || along > length) return false;
      return Math.abs(-dx * uy + dy * ux) < width / 2 + along * 0.05;
    };
  }
  const trees = collectTrees({ world, hf, cam: camPt, frustum, sampleMask, exclude, denseR: view.denseR ?? (c.type === 'chase' ? 1400 : 2600), maxDist: view.treeMax ?? 14000 });
  const treeGroup = buildTreeMeshes(trees, makeTreeMaterial(U, envMap));
  scene.add(treeGroup);
  lap('trees ' + treeGroup.userData.total);

  if (rider) {
    const rg = buildRider(U, envMap, { crankDeg: view.crank ?? 35 });
    rg.position.copy(toThree(rider.x, rider.y, rider.h - 0.02));
    // +x local = forward along route; three heading: world (dx,dy) -> three (dx, 0, -dy)
    rg.rotation.y = Math.atan2(rider.dy, rider.dx);
    scene.add(rg);
    // report the rider's exact screen box (every vertex projected)
    rg.updateMatrixWorld(true);
    let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
    const pv = new THREE.Vector3();
    rg.traverse((o) => {
      if (!o.isMesh) return;
      const pa = o.geometry.attributes.position;
      for (let i = 0; i < pa.count; i += 3) {
        pv.fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld).project(cam);
        const sx = (pv.x + 1) / 2, sy = (1 - pv.y) / 2;
        top = Math.min(top, sy); bottom = Math.max(bottom, sy); left = Math.min(left, sx); right = Math.max(right, sx);
      }
    });
    window.__riderBox = { top, bottom, left, right };
    log('rider box', JSON.stringify(window.__riderBox));
  }

  // ---------------- lights ----------------
  const sun = new THREE.DirectionalLight(new THREE.Color(mood.sunColor), mood.sun);
  const focusD = view.shadowFocus ?? (c.type === 'chase' ? 18 : 700);
  const focus = toThree(camW[0] + fwdXY.x * focusD, camW[1] + fwdXY.y * focusD, hf.sample(camW[0] + fwdXY.x * focusD, camW[1] + fwdXY.y * focusD));
  sun.position.copy(focus).add(sunDir.clone().multiplyScalar(3000));
  sun.target.position.copy(focus);
  sun.castShadow = mood.sun > 0.5;
  const sb = view.shadowBox ?? (c.type === 'chase' ? 90 : 1500);
  Object.assign(sun.shadow.camera, { left: -sb, right: sb, top: sb, bottom: -sb, near: 10, far: 6000 });
  sun.shadow.mapSize.set(8192, 8192);
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = c.type === 'chase' ? 0.02 : 0.6;
  sun.shadow.radius = 2;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(new THREE.Color(mood.hemiSky), new THREE.Color(mood.hemiGround), mood.hemi);
  scene.add(hemi);
  for (const m of [groundMat]) m.envMapIntensity = mood.env;
  scene.traverse((o) => { if (o.material && o.material.envMap) o.material.envMapIntensity = mood.env * (o.material === groundMat ? 1 : 1.1); });

  // night: street lights as glowing points along roads in built-up areas
  if (mood.night > 0) {
    scene.add(streetLights(world, hf, sampleMask, camPt, frustum));
    scene.add(pathLamps(world, hf, camPt, frustum, U, envMap));
  }

  // ---------------- render ----------------
  const rt = new THREE.WebGLRenderTarget(W * SS, H * SS, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(1);
  composer.setSize(W * SS, H * SS);
  const skyPass = new RenderPass(skyScene, cam);
  composer.addPass(skyPass);
  const mainPass = new RenderPass(scene, cam);
  mainPass.clear = false;
  mainPass.clearDepth = true;
  composer.addPass(mainPass);
  // bloom stays subtle in HDR; halation and the film grade happen in shoot.py finish()
  const bloom = new UnrealBloomPass(new THREE.Vector2(W * SS, H * SS), mood.night ? 0.6 : 0.22, 0.6, mood.night ? 0.32 : 1.15);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  lap('setup');
  composer.render();
  const gl = renderer.getContext();
  gl.finish();
  lap('rendered');
  window.__thumbDone = true;
}

/** Park-path lamps along the ride routes near the camera: posts, glowing heads, and real point lights for the nearest. */
function pathLamps(world, hf, cam, frustum, U, envMap) {
  const g = new THREE.Group();
  const heads = [];
  const v = new THREE.Vector3();
  for (const rt of world.routes) {
    for (let s = 0; s < rt.lengthM; s += 34) {
      const p = routeAt(rt, s);
      const x = p.x - p.dy * 2.4, y = p.y + p.dx * 2.4;
      const d = Math.hypot(x - cam.x, y - cam.y);
      if (d > 1800) continue;
      const h = hf.sample(x, y);
      v.set(x, h + 2, -y);
      if (!frustum.intersectsSphere(new THREE.Sphere(v, 4))) continue;
      heads.push([x, y, h, d]);
    }
  }
  const postGeo = new THREE.CylinderGeometry(0.05, 0.07, 4.2, 6).translate(0, 2.1, 0);
  const posts = new THREE.InstancedMesh(postGeo, new THREE.MeshStandardMaterial({ color: '#1c1c1e', roughness: 0.6, metalness: 0.4 }), Math.max(1, heads.length));
  const m4 = new THREE.Matrix4();
  heads.forEach(([x, y, h], i) => posts.setMatrixAt(i, m4.makeTranslation(x, h, -y)));
  posts.count = heads.length;
  g.add(posts);
  const pos = [];
  for (const [x, y, h] of heads) pos.push(x, h + 4.25, -y);
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const sprite = document.createElement('canvas');
  sprite.width = sprite.height = 64;
  const sc = sprite.getContext('2d');
  const grd = sc.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,240,215,1)'); grd.addColorStop(0.12, 'rgba(255,200,140,0.8)'); grd.addColorStop(1, 'rgba(255,150,80,0)');
  sc.fillStyle = grd; sc.fillRect(0, 0, 64, 64);
  const pts = new THREE.Points(pg, new THREE.PointsMaterial({ map: new THREE.CanvasTexture(sprite), color: new THREE.Color(6, 4, 2.4), size: 1.6, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  pts.frustumCulled = false;
  g.add(pts);
  heads.sort((a, b) => a[3] - b[3]);
  for (const [x, y, h] of heads.slice(0, 10)) {
    const L = new THREE.PointLight(new THREE.Color('#ffb36b'), 60, 30, 2);
    L.position.set(x, h + 4.1, -y);
    g.add(L);
  }
  log('path lamps', heads.length);
  return g;
}

function streetLights(world, hf, sampleMask, cam, frustum) {
  const pos = [];
  const v = new THREE.Vector3();
  for (const rd of world.roads.roads) {
    if (rd.c > 9 || rd.c === 8) continue;
    const p = rd.p;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i] / 10, ay = p[i + 1] / 10, bx = p[i + 2] / 10, by = p[i + 3] / 10;
      const len = Math.hypot(bx - ax, by - ay);
      for (let t = 0; t < len; t += 28) {
        const x = ax + (bx - ax) * (t / len), y = ay + (by - ay) * (t / len);
        if (Math.hypot(x - cam.x, y - cam.y) > 16000) continue;
        const m = sampleMask(x, y);
        if (!m || m.cls < 180 || m.cls > 210) continue;
        const h = hf.sample(x, y) + 6;
        v.set(x, h, -y);
        if (!frustum.containsPoint(v)) continue;
        pos.push(x, h, -y);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const sprite = document.createElement('canvas');
  sprite.width = sprite.height = 64;
  const sc = sprite.getContext('2d');
  const grd = sc.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,235,200,1)'); grd.addColorStop(0.2, 'rgba(255,190,120,0.6)'); grd.addColorStop(1, 'rgba(255,150,80,0)');
  sc.fillStyle = grd; sc.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(sprite);
  const mat = new THREE.PointsMaterial({ map: tex, color: new THREE.Color(4.0, 2.6, 1.4), size: 9, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  log('street lights', pos.length / 3);
  return pts;
}

main().catch((e) => { console.error(e); window.__thumbError = String(e && e.stack || e); });
