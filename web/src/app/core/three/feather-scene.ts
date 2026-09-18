import * as THREE from 'three';

export interface FeatherSceneOptions {
  /** Renderer clear color — transparent lets the page's own ground show
   *  through, which is what every current mount point wants. */
  background?: THREE.ColorRepresentation | null;
  /** Radians/second of idle auto-rotation around Y. */
  spinSpeed?: number;
  /** Whether to draw the soft contact-shadow disc beneath the emblem — on
   *  for the bright login/landing hero, off for the dark TV backdrop where
   *  there is no "floor" to cast onto. */
  groundShadow?: boolean;
  /** Camera distance — closer for a hero mount, further for an ambient
   *  backdrop where the emblem is a small moving detail, not the subject. */
  cameraDistance?: number;
}

export interface FeatherScene {
  /** Call on every animation frame the host wants rendered — the host
   *  directive owns the requestAnimationFrame loop so it can pause it via
   *  IntersectionObserver without this module knowing anything about
   *  visibility. */
  tick(deltaSeconds: number): void;
  /** Nudges the emblem's tilt toward a pointer/gyro-driven target, in the
   *  range [-1, 1] on each axis. Called at most once per frame; the actual
   *  rotation eases toward this rather than snapping. */
  setPointer(x: number, y: number): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

/**
 * The app's own feather-arc mark (shared/icon/icon.ts's `feather` glyph),
 * given real depth — not a sculpted, free-standing shuttlecock. Three
 * earlier passes tried to build an actual shuttlecock from primitive
 * geometry (degenerate spike cones, then many narrow blades, then one
 * continuous lathed skirt) and every one of them read as some other
 * object — a woven basket, a lampshade, a cup — because getting an organic
 * multi-part shape to look intentional from arbitrary rotation angles is
 * genuinely hard, and a small decorative hero isn't worth that much tuning.
 *
 * This instead extrudes the *exact* cubic-bezier paths the 2D icon already
 * draws — the same four tapered petal shapes fanning from a shared base,
 * plus the stem — as flat filled shapes pushed out along Z with a bevel.
 * There is no "does this read as the intended object" risk left to solve:
 * the silhouette is already the app's own proven mark, just thickened.
 */
export function createFeatherScene(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  options: FeatherSceneOptions = {}
): FeatherScene {
  const { background = null, spinSpeed = 0.35, groundShadow = true, cameraDistance = 6.5 } = options;

  const scene = new THREE.Scene();
  if (background !== null) scene.background = new THREE.Color(background);

  const camera = new THREE.PerspectiveCamera(32, width / height, 0.1, 100);
  camera.position.set(0, 0.3, cameraDistance);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: background === null });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;

  // Studio lighting, warm/neutral. Intensities are well above what pre-r155
  // three.js code would use — this three.js version's physically-correct
  // lighting units read old "intensity: 1"-style values as badly
  // underexposed, which is what first rendered an earlier attempt's cream
  // material as flat slate gray regardless of its actual color value.
  scene.add(new THREE.AmbientLight(0xffffff, 2.0));
  const key = new THREE.DirectionalLight(0xffffff, 3.0);
  key.position.set(3, 4, 5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xe8f3ec, 1.2);
  fill.position.set(-4, 1, 3);
  scene.add(fill);

  const emblem = buildFeatherEmblem();
  scene.add(emblem.group);

  if (groundShadow) {
    const shadowTexture = createRadialShadowTexture();
    const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false });
    const shadowDisc = new THREE.Mesh(new THREE.CircleGeometry(1.6, 32), shadowMat);
    shadowDisc.rotation.x = -Math.PI / 2;
    shadowDisc.position.y = -1.15;
    scene.add(shadowDisc);
  }

  const targetTilt = { x: 0, y: 0 };
  const currentTilt = { x: 0, y: 0 };
  let elapsed = 0;

  function tick(deltaSeconds: number): void {
    elapsed += deltaSeconds;
    emblem.group.rotation.y = elapsed * spinSpeed;

    // Ease toward the pointer/gyro target rather than snapping — a bare
    // pointer-follow reads as nervous on a screen this size.
    currentTilt.x += (targetTilt.x - currentTilt.x) * Math.min(deltaSeconds * 3, 1);
    currentTilt.y += (targetTilt.y - currentTilt.y) * Math.min(deltaSeconds * 3, 1);
    emblem.group.rotation.x = 0.1 + currentTilt.y * 0.25;
    emblem.group.rotation.z = currentTilt.x * 0.15;

    renderer.render(scene, camera);
  }

  function setPointer(x: number, y: number): void {
    targetTilt.x = THREE.MathUtils.clamp(x, -1, 1);
    targetTilt.y = THREE.MathUtils.clamp(y, -1, 1);
  }

  function resize(w: number, h: number): void {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  function dispose(): void {
    emblem.dispose();
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshBasicMaterial) {
        obj.material.map?.dispose();
        obj.material.dispose();
        obj.geometry.dispose();
      }
    });
    renderer.dispose();
  }

  return { tick, setPointer, resize, dispose };
}

/**
 * Builds the four-petal-plus-stem emblem from the same path coordinates as
 * `shared/icon/icon.ts`'s `feather` case (a 0–24 SVG viewBox). SVG's Y axis
 * points down; `pt()` negates it so "down in the icon" stays "down" once
 * these coordinates become a Y-up three.js shape, rather than rendering the
 * whole mark upside down.
 */
function buildFeatherEmblem(): { group: THREE.Group; dispose(): void } {
  const scale = 0.16;
  const pt = (x: number, y: number) => new THREE.Vector2(x * scale, -y * scale);

  // Two big petals (the icon's full-opacity paths) and two smaller ones
  // (its 60%-opacity paths) — three.js shapes don't carry opacity as
  // cheaply as SVG does, so the size difference alone carries the same
  // "primary vs. secondary" read the 2D icon uses.
  const bigPetalRight = new THREE.Shape();
  bigPetalRight.moveTo(...pt(12, 9).toArray());
  bigPetalRight.bezierCurveTo(...pt(12, 9).toArray(), ...pt(7, 8).toArray(), ...pt(6, 3).toArray());
  bigPetalRight.bezierCurveTo(...pt(10.5, 3.5).toArray(), ...pt(12, 6.5).toArray(), ...pt(12, 9).toArray());

  const bigPetalLeft = new THREE.Shape();
  bigPetalLeft.moveTo(...pt(12, 9).toArray());
  bigPetalLeft.bezierCurveTo(...pt(12, 9).toArray(), ...pt(17, 8).toArray(), ...pt(18, 3).toArray());
  bigPetalLeft.bezierCurveTo(...pt(13.5, 3.5).toArray(), ...pt(12, 6.5).toArray(), ...pt(12, 9).toArray());

  const smallPetalRight = new THREE.Shape();
  smallPetalRight.moveTo(...pt(12, 12).toArray());
  smallPetalRight.bezierCurveTo(...pt(12, 12).toArray(), ...pt(8.5, 11.2).toArray(), ...pt(7.7, 7.5).toArray());
  smallPetalRight.bezierCurveTo(...pt(11, 8).toArray(), ...pt(12, 10.2).toArray(), ...pt(12, 12).toArray());

  const smallPetalLeft = new THREE.Shape();
  smallPetalLeft.moveTo(...pt(12, 12).toArray());
  smallPetalLeft.bezierCurveTo(...pt(12, 12).toArray(), ...pt(15.5, 11.2).toArray(), ...pt(16.3, 7.5).toArray());
  smallPetalLeft.bezierCurveTo(...pt(13, 8).toArray(), ...pt(12, 10.2).toArray(), ...pt(12, 12).toArray());

  const petalMaterial = new THREE.MeshStandardMaterial({ color: 0x2c8a51, roughness: 0.45, metalness: 0.05 });
  const petalDepth = 1.1 * scale;
  const extrudeSettings: THREE.ExtrudeGeometryOptions = {
    depth: petalDepth,
    bevelEnabled: true,
    bevelThickness: petalDepth * 0.25,
    bevelSize: petalDepth * 0.2,
    bevelSegments: 3,
    curveSegments: 16,
  };

  const group = new THREE.Group();
  const geometries: THREE.ExtrudeGeometry[] = [];
  for (const shape of [bigPetalRight, bigPetalLeft, smallPetalRight, smallPetalLeft]) {
    const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
    geometry.translate(0, 0, -petalDepth / 2); // centers the extrusion on Z instead of running 0→depth
    geometries.push(geometry);
    group.add(new THREE.Mesh(geometry, petalMaterial));
  }

  // The stem below the fan (`M12 21V9` in the icon) — a thin rounded bar
  // rather than a sharp box, so it reads as a stalk and not a ruler.
  const stemMaterial = new THREE.MeshStandardMaterial({ color: 0x2c8a51, roughness: 0.45, metalness: 0.05 });
  const stemHeight = (21 - 9) * scale;
  const stemGeometry = new THREE.CapsuleGeometry(0.35 * scale, stemHeight - 0.7 * scale, 4, 8);
  const stem = new THREE.Mesh(stemGeometry, stemMaterial);
  stem.position.set(12 * scale, -(21 + 9) / 2 * scale, 0);
  group.add(stem);

  // All four petal shapes converge on the icon's own (12, 9) / (12, 12)
  // anchor points, so building them at their natural coordinates already
  // reproduces the 2D icon's fan layout with no per-petal angle math. This
  // just recenters the finished assembly at the local origin so the camera
  // and the auto-rotation both pivot around its actual visual middle
  // instead of the icon's arbitrary (0,0) SVG corner.
  const box = new THREE.Box3().setFromObject(group);
  const center = box.getCenter(new THREE.Vector3());
  for (const child of group.children) child.position.sub(center);

  function dispose(): void {
    for (const geometry of geometries) geometry.dispose();
    stemGeometry.dispose();
    petalMaterial.dispose();
    stemMaterial.dispose();
  }

  return { group, dispose };
}

/** A soft radial falloff baked into a small canvas texture, cheaper and
 *  simpler than a real shadow map for a decorative contact shadow. */
function createRadialShadowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(20, 20, 10, 0.35)');
  gradient.addColorStop(1, 'rgba(20, 20, 10, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}
