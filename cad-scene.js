/**
 * AI Process Unit — scroll-driven CAD scene.
 *
 * Physically-based / realistic render setup (after the Three.js Journey
 * "Realistic render" lesson): ACES filmic tone mapping + tuned exposure,
 * sRGB output, image-based lighting from a PMREM'd RoomEnvironment for soft
 * global illumination, a warm key + cool rim/fill, and soft contact shadows
 * cleaned up with shadow.normalBias (kills acne on the rounded geometry).
 *
 * Three scroll states across the pinned 3×100vh section:
 *   01 normal position  →  02 zoom into geometry  →  03 zoom + rear-side spin
 *
 * Externalised from index.html for readability; still build-less — resolved
 * through the page's <script type="importmap"> and served over HTTP.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { HorizontalBlurShader } from "three/addons/shaders/HorizontalBlurShader.js";
import { VerticalBlurShader } from "three/addons/shaders/VerticalBlurShader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const cadStage = document.querySelector("[data-cad-stage]");
const cadCanvas = document.querySelector("[data-cad-canvas]");
const cadSteps = Array.from(document.querySelectorAll("[data-cad-step]"));
const cadCopies = Array.from(document.querySelectorAll("[data-cad-copy]"));
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

if (cadStage && cadCanvas) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  const renderer = new THREE.WebGLRenderer({
    canvas: cadCanvas,
    alpha: true,
    antialias: true,
    powerPreference: "high-performance"
  });
  const clock = new THREE.Clock();
  const scrollRig = new THREE.Group();
  const spinRig = new THREE.Group();
  let cadProgress = 0;
  let loadedModel = null;

  camera.position.set(0, 0.05, 5.4);
  scrollRig.position.set(0, -0.4, 0);
  scrollRig.rotation.set(0.08, -0.36, 0);
  scrollRig.add(spinRig);
  scene.add(scrollRig);

  // Opaque dark background (the bloom composer can't preserve canvas alpha);
  // the .unit-stage section CSS is matched to this so there is no visible seam.
  renderer.setClearColor(0x080a0d, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.32;
  // Ground shadow is a soft contact shadow (below), not a shadow map.
  renderer.shadowMap.enabled = false;

  // Image-based lighting → soft global illumination + realistic reflections.
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const roomEnvironment = new RoomEnvironment(renderer);
  scene.environment = pmremGenerator.fromScene(roomEnvironment, 0.04).texture;
  roomEnvironment.dispose();
  pmremGenerator.dispose();

  // Warm key light (shaping only; ground shadow is the soft contact shadow below).
  const keyLight = new THREE.DirectionalLight(0xfff4e6, 2.0);
  keyLight.position.set(4.2, 6.0, 5.2);
  scene.add(keyLight);

  // Cool rim for separation from the dark background.
  const rimLight = new THREE.DirectionalLight(0x9bc7ff, 1.1);
  rimLight.position.set(-5.4, 2.8, -4.8);
  scene.add(rimLight);

  // Sky/ground bounce fill.
  const fillLight = new THREE.HemisphereLight(0xdbe6ff, 0x0a0c10, 0.45);
  scene.add(fillLight);

  // --- Soft contact shadow (three.js webgl_shadow_contact technique) ---------
  // Render the scene depth from an up-looking ortho camera at the model base,
  // then blur it twice into a transparent texture shown on a ground plane.
  // Gives a soft, realistic contact shadow with no hard shadow-map edges.
  const SHADOW_PLANE = 3.2;   // catcher size (world units)
  const SHADOW_CAM_H = 1.4;   // how far up the object casts a shadow
  const SHADOW_BLUR = 3.4;
  const SHADOW_OPACITY = 0.9;
  const SHADOW_DARKNESS = 1.4;

  const shadowGroup = new THREE.Group();
  scene.add(shadowGroup);

  const shadowRT = new THREE.WebGLRenderTarget(512, 512);
  shadowRT.texture.generateMipmaps = false;
  const shadowRTBlur = new THREE.WebGLRenderTarget(512, 512);
  shadowRTBlur.texture.generateMipmaps = false;

  const shadowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(SHADOW_PLANE, SHADOW_PLANE).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({
      map: shadowRT.texture,
      transparent: true,
      opacity: SHADOW_OPACITY,
      depthWrite: false,
      toneMapped: false
    })
  );
  shadowPlane.renderOrder = -1;
  shadowGroup.add(shadowPlane);

  // Invisible helper plane used only to run the blur passes fullscreen.
  const blurPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(SHADOW_PLANE, SHADOW_PLANE).rotateX(Math.PI / 2)
  );
  blurPlane.visible = false;
  shadowGroup.add(blurPlane);

  const shadowCamera = new THREE.OrthographicCamera(
    -SHADOW_PLANE / 2, SHADOW_PLANE / 2, SHADOW_PLANE / 2, -SHADOW_PLANE / 2, 0, SHADOW_CAM_H
  );
  shadowCamera.rotation.x = Math.PI / 2; // look straight up
  shadowGroup.add(shadowCamera);

  // Depth material that writes shadow density into the alpha channel.
  const depthMaterial = new THREE.MeshDepthMaterial();
  depthMaterial.userData.darkness = { value: SHADOW_DARKNESS };
  depthMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.darkness = depthMaterial.userData.darkness;
    shader.fragmentShader = "uniform float darkness;\n" + shader.fragmentShader.replace(
      "gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );",
      "gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );"
    );
  };
  depthMaterial.depthTest = false;
  depthMaterial.depthWrite = false;

  const hBlur = new THREE.ShaderMaterial(HorizontalBlurShader);
  hBlur.depthTest = false;
  const vBlur = new THREE.ShaderMaterial(VerticalBlurShader);
  vBlur.depthTest = false;

  const blurShadow = (amount) => {
    blurPlane.visible = true;
    blurPlane.material = hBlur;
    hBlur.uniforms.tDiffuse.value = shadowRT.texture;
    hBlur.uniforms.h.value = amount / 256;
    renderer.setRenderTarget(shadowRTBlur);
    renderer.render(blurPlane, shadowCamera);

    blurPlane.material = vBlur;
    vBlur.uniforms.tDiffuse.value = shadowRTBlur.texture;
    vBlur.uniforms.v.value = amount / 256;
    renderer.setRenderTarget(shadowRT);
    renderer.render(blurPlane, shadowCamera);

    blurPlane.visible = false;
  };

  const renderShadow = () => {
    const prevBg = scene.background;
    const prevAlpha = renderer.getClearAlpha();
    scene.background = null;
    renderer.setClearAlpha(0); // shadow density lives in the alpha channel
    shadowPlane.visible = false; // don't capture the catcher itself
    scene.overrideMaterial = depthMaterial;
    renderer.setRenderTarget(shadowRT);
    renderer.render(scene, shadowCamera);
    scene.overrideMaterial = null;
    blurShadow(SHADOW_BLUR);
    blurShadow(SHADOW_BLUR * 0.4);
    renderer.setRenderTarget(null);
    renderer.setClearAlpha(prevAlpha);
    shadowPlane.visible = true;
    scene.background = prevBg;
  };

  // Postprocessing: a gentle bloom so only the bright LED emissive glows.
  // High threshold keeps the (much dimmer) lit body out of the bloom.
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.32, 1.15);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  const setCadStep = (progress) => {
    const activeIndex = progress < 0.34 ? 0 : progress < 0.68 ? 1 : 2;
    cadSteps.forEach((step, index) => {
      step.classList.toggle("is-active", index === activeIndex);
    });
    cadCopies.forEach((copy, index) => {
      copy.classList.toggle("is-active", index === activeIndex);
    });
  };

  const resizeCad = () => {
    const bounds = cadCanvas.parentElement.getBoundingClientRect();
    const width = Math.max(1, Math.floor(bounds.width));
    const height = Math.max(1, Math.floor(bounds.height));
    renderer.setSize(width, height, false);
    composer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const tuneModelMaterial = (material) => {
    if (!material) return;
    if ("envMapIntensity" in material) material.envMapIntensity = 0.7;
    if ("roughness" in material && typeof material.roughness === "number") {
      material.roughness = THREE.MathUtils.clamp(material.roughness, 0.35, 0.92);
    }

    // Drive the blue LED strip bright enough to bloom → a soft glow.
    const col = material.color;
    const emi = material.emissive;
    const alreadyEmissive = emi && emi.r + emi.g + emi.b > 0.05;
    const looksLikeLed =
      col && col.b > 0.22 && col.b >= col.r && col.b >= col.g && col.b - col.r > 0.08;
    if (alreadyEmissive || looksLikeLed) {
      if (!alreadyEmissive) material.emissive = col.clone(); // keep the GLB's own emissive tint when present
      material.emissiveIntensity = 6.0;
      material.toneMapped = true;
    }

    material.needsUpdate = true;
  };

  const normalizeModel = (model) => {
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z) || 1;

    model.position.sub(center);
    model.scale.setScalar(1.4 / maxDimension);
    model.traverse((child) => {
      if (!child.isMesh) return;
      child.castShadow = true;
      child.receiveShadow = true;
      if (Array.isArray(child.material)) {
        child.material.forEach(tuneModelMaterial);
      } else {
        tuneModelMaterial(child.material);
      }
    });

    return model;
  };

  const setupCadScroll = () => {
    if (!window.gsap || !window.ScrollTrigger || prefersReducedMotion.matches) {
      setCadStep(0);
      return;
    }

    window.gsap.registerPlugin(window.ScrollTrigger);
    window.gsap.timeline({
      scrollTrigger: {
        trigger: cadStage,
        start: "top top",
        end: "bottom bottom",
        scrub: 0.8, // smoothing lag → eased reaction to scroll instead of 1:1
        onUpdate: (self) => {
          cadProgress = self.progress;
          setCadStep(self.progress);
        }
      }
    })
      .to(camera.position, { z: 4.3, y: 0.1, duration: 1, ease: "none" }, 0)
      .to(scrollRig.rotation, { x: 0.05, y: 0.28, duration: 1, ease: "none" }, 0)
      .to(camera.position, { z: 3.6, y: 0.06, duration: 1, ease: "none" }, 1)
      .to(scrollRig.position, { x: 0.1, duration: 2, ease: "none" }, 0)
      .to(scrollRig.rotation, { x: 0.02, y: Math.PI + 0.24, duration: 1, ease: "none" }, 1);
  };

  const renderCad = () => {
    const delta = Math.min(clock.getDelta(), 0.04);
    const rearSpin = THREE.MathUtils.smoothstep(cadProgress, 0.68, 1);

    // Gentle constant idle rotation — keeps the object alive from the very start
    // and hides any scroll-scrub micro-stutter — with a faster boost on the
    // rear-side reveal.
    if (loadedModel && !prefersReducedMotion.matches) {
      spinRig.rotation.y += delta * (0.06 + 0.34 * rearSpin);
    }

    camera.lookAt(0, 0, 0);
    if (loadedModel) renderShadow();
    composer.render();
    window.requestAnimationFrame(renderCad);
  };

  resizeCad();
  renderCad();

  new GLTFLoader().load(
    "../assets/cad-model/threeJS.model.glb",
    (gltf) => {
      loadedModel = normalizeModel(gltf.scene);
      spinRig.add(loadedModel);
      // Sit the soft contact shadow on the model's base (world-space min Y).
      const worldBox = new THREE.Box3().setFromObject(loadedModel);
      shadowGroup.position.y = worldBox.min.y + 0.001;
      cadStage.classList.add("is-model-loaded");
      setupCadScroll();
      if (window.ScrollTrigger) window.ScrollTrigger.refresh();
    },
    undefined,
    (error) => {
      console.warn("CAD model failed to load", error);
      cadStage.classList.add("is-model-loaded", "is-model-failed");
      setupCadScroll();
    }
  );

  window.addEventListener("resize", () => {
    resizeCad();
    if (window.ScrollTrigger) window.ScrollTrigger.refresh();
  });
}
