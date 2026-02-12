import { loadGLTF } from "./libs/loader.js";
import { RGBELoader } from "./libs/three.js-r132/examples/jsm/loaders/RGBELoader.js";

function debounce(func, timeout = 500) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { func.apply(this, args); }, timeout);
  };
}

function wrapText(text, font, fontSize, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = words[0];
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const testLine = currentLine + " " + word;
    const shapes = font.generateShapes(testLine, fontSize);
    const geometry = new THREE.ShapeGeometry(shapes);
    geometry.computeBoundingBox();
    const width = geometry.boundingBox.max.x - geometry.boundingBox.min.x;
    if (width > maxWidth) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  lines.push(currentLine);
  return lines;
}

const THREE = window.MINDAR.IMAGE.THREE;

document.addEventListener("DOMContentLoaded", async () => {
  const presets = await (await fetch("./presets.json")).json();
  const pathParts = window.location.pathname.split('/').filter(p => p.length > 0);
  const presetNameFromUrl = pathParts[0] || 'valentine';

  let matchedPresetKey = 'valentine'; // Default to 'valentine' key
  for (const key in presets) {
    if (key.toLowerCase() === presetNameFromUrl.toLowerCase().replace(/-/g, '')) {
      matchedPresetKey = key;
      break;
    }
    // Special case for 'valentine' where key is 'valentine' and URL part is 'valentine'
    if (key.toLowerCase() === presetNameFromUrl.toLowerCase() && key === 'valentine') {
      matchedPresetKey = key;
      break;
    }
  }

  const presetName = matchedPresetKey;
  const cardId = pathParts[1] || 'default_card';
  const preset = presets[presetName]; // Use the matched key

  posthog.identify(cardId);
  posthog.capture('card_visited', {
    preset: presetName,
    card_id: cardId
  });

  const arTargetImage = document.getElementById('ar-target-image');
  if (arTargetImage && preset.displayImage) {
    arTargetImage.src = preset.displayImage;
  }

  const mindarThree = new window.MINDAR.IMAGE.MindARThree({
    container: document.body,
    imageTargetSrc: preset.target,
    uiScanning: "#scanning-overlay",
  });

  const { renderer, scene, camera } = mindarThree;
  renderer.outputEncoding = THREE.sRGBEncoding;

  const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
  scene.add(light);

  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();

  const envMap = await new RGBELoader().loadAsync(preset.envMap);
  const hdrTexture = pmremGenerator.fromEquirectangular(envMap).texture;
  hdrTexture.colorSpace = THREE.SRGBColorSpace;
  scene.environment = hdrTexture;

  let imageTexturePlane = null;
  let invisiblePlane = null;
  let mixer = null;
  let cropper = null;

  try {
    const raccoon = await loadGLTF(preset.model);
    raccoon.scene.scale.set(preset.modelScale, preset.modelScale, preset.modelScale);
    raccoon.scene.position.set(...preset.modelPosition);
    raccoon.scene.rotation.set(...preset.modelRotation);
    const audio = document.getElementById('background-music');
    const startARButton = document.getElementById('start-ar-button');

    startARButton.addEventListener("click", () => {
      if (audio) {
        audio.play().then(() => {
          audio.pause();
          audio.currentTime = 0;
        }).catch(err => console.warn("Audio unlock failed:", err));
      }
    });

    raccoon.scene.traverse((o) => {
      if (o.isMesh) {
        if (o.name === "Image_Plain_Texture") {
          imageTexturePlane = o;
        }
        if (o.material && (o.material.isMeshStandardMaterial || o.material.isMeshPhysicalMaterial)) {
          o.material.envMap = hdrTexture;
          o.material.envMapIntensity = 1;
          o.material.needsUpdate = true;
        }
      }
    });

    const anchor = mindarThree.addAnchor(0);
    anchor.group.add(raccoon.scene);

    anchor.onTargetFound = () => {
      if (audio) audio.play();
    };

    anchor.onTargetLost = () => {
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
      }
    };

    // Invisible Plane 
    const geometry = new THREE.PlaneGeometry(2.5, 1.2);
    const planeMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide
    });
    invisiblePlane = new THREE.Mesh(geometry, planeMaterial);
    const planePos = preset.planePosition || [0, -0.7, 0.25];
    invisiblePlane.position.set(...planePos);
    anchor.group.add(invisiblePlane);

    mixer = new THREE.AnimationMixer(raccoon.scene);
    raccoon.animations.forEach((clip) => mixer.clipAction(clip).play());

    // UI & Font Logic
    const fontLoader = new THREE.FontLoader();
    fontLoader.load("assets/fonts/great-vibes.json", function (font) {
      const textInput = document.getElementById("text-input");
      const colorPicker = document.getElementById("color-picker");
      const textSizeInput = document.getElementById("text-size");
      const imageBtn = document.getElementById('image-btn');
      const applyTextBtn = document.getElementById('apply-text-btn');
      let textGroup;

      const textMaterial = new THREE.MeshStandardMaterial({
        color: colorPicker.value,
        metalness: 0.3,
        roughness: 0.4,
        envMap: hdrTexture,
      });

      const captureColorChange = debounce((colorValue) => {
        posthog.capture('Card Data Updated', {
          cardId: cardId,
          preset: presetName,
          type: 'color-change', // Differentiated name
          update_type: 'color_change',
          color: colorValue
        });
      }, 1000);

      textInput.addEventListener('input', function () {
        const words = this.value.trim().split(/\s+/);
        if (words.length > 30) {
          this.value = words.slice(0, 30).join(" ");
        }
      });

      const updateTextGeometry = () => {
        const text = textInput.value;
        if (!text.trim()) {
          if (textGroup) textGroup.scale.set(0, 0, 0);
          return;
        }

        const FONT_SIZE = 0.2;
        const MAX_WIDTH = 2.8;
        const LINE_HEIGHT = 0.2;

        if (!textGroup) {
          textGroup = new THREE.Group();
          if (invisiblePlane) invisiblePlane.add(textGroup);
        } else {
          textGroup.children.forEach((child) => { if (child.isMesh) child.geometry.dispose(); });
          textGroup.clear();
        }

        const paragraphs = text.split("\n");
        let allLines = [];
        paragraphs.forEach(p => {
          if (p.trim() === "") allLines.push("");
          else allLines = allLines.concat(wrapText(p, font, FONT_SIZE, MAX_WIDTH));
        });

        allLines.forEach((line, index) => {
          if (line.trim() === "") return;
          const textGeo = new THREE.TextGeometry(line, { font: font, size: FONT_SIZE, height: 0.01 });

          // Horizontal center, but anchor Y to 0 so Line 1 stays put
          textGeo.computeBoundingBox();
          const xMid = -0.5 * (textGeo.boundingBox.max.x - textGeo.boundingBox.min.x);
          textGeo.translate(xMid, 0, 0);

          const lineMesh = new THREE.Mesh(textGeo, textMaterial);
          lineMesh.position.y = -index * LINE_HEIGHT;
          textGroup.add(lineMesh);
        });

        const sliderScale = (parseFloat(textSizeInput.value) || 0.5) / 2;
        textGroup.scale.set(sliderScale, sliderScale, sliderScale);
        textGroup.position.set(...preset.textPosition);

        textGroup.traverse((object) => {
          if (object.isMesh) {
            // Ensure the material knows it has an environment map
            if (object.material) {
              object.material.envMap = hdrTexture;
              object.material.needsUpdate = true;
            }
          }
        });
        textGroup.updateMatrixWorld(true);
      };

      const applyTexture = (textureUrl) => {
        const textureLoader = new THREE.TextureLoader();
        const cacheBusterUrl = `${textureUrl}?t=${Date.now()}`;
        const previewContainer = document.getElementById('image-preview-container');
        const previewImg = document.getElementById('preview-img');

        if (previewImg) {
          previewImg.src = cacheBusterUrl;
          previewContainer.style.display = 'flex';
        }

        textureLoader.load(cacheBusterUrl, (texture) => {
          if (imageTexturePlane) {
            texture.flipY = false;
            texture.encoding = THREE.sRGBEncoding;

            if (imageTexturePlane.material && (imageTexturePlane.material.isMeshStandardMaterial || imageTexturePlane.material.isMeshPhysicalMaterial)) {
              // If it's a PBR material, just update the map and flag for update
              imageTexturePlane.material.map = texture;
              imageTexturePlane.material.needsUpdate = true;
            } else {
              // Fallback to MeshBasicMaterial if it's not a PBR material or if we want basic
              imageTexturePlane.material = new THREE.MeshBasicMaterial({
                map: texture,
                transparent: true,
                toneMapped: false,
              });
            }
          }
        });
      };

      const uploadImage = async (blob) => {
        const formData = new FormData();
        formData.append("image", blob, "val_upload.png");
        try {
          const response = await fetch(`/api/upload/${presetName}/${cardId}`, { method: "POST", body: formData });
          if (response.ok) {
            const data = await response.json();
            applyTexture(data.filePath);
            saveCardData(textInput.value, colorPicker.value, textSizeInput.value, data.filePath);

            posthog.capture('Image Uploaded', {
              cardId: cardId,
              preset: presetName, // New
              type: 'image',      // New
              filePath: data.filePath
            });

            imageBtn.textContent = "Updated";
            imageBtn.style.background = "#4CAF50";
            setTimeout(() => {
              imageBtn.textContent = "Update Image";
              imageBtn.style.background = "#dda0dd";
            }, 2000);
            document.getElementById("cropper-modal").style.display = "none";
          }
        } catch (err) { console.error("Upload failed:", err); }
      };

      const saveCardData = async (text, color, size, imagePath = null) => {
        try {
          const res = await fetch(`/api/card-data/${presetName}/${cardId}`);
          const existing = await res.json();
          const payload = { text, color, size, imagePath: imagePath || existing.imagePath };
          await fetch(`/api/card-data/${presetName}/${cardId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
        } catch (err) { console.error("Save failed:", err); }
      };

      const updateSliderTrack = (input) => {
        const min = input.min || 0;
        const max = input.max || 1;
        const value = ((input.value - min) / (max - min)) * 100;
        input.style.setProperty('--value', value + '%');
      };

      const loadSavedData = async () => {
        try {
          const response = await fetch(`/api/card-data/${presetName}/${cardId}`);
          if (response.ok) {
            const data = await response.json();
            if (data.text) {
              textInput.value = data.text;
              colorPicker.value = data.color;
              textSizeInput.value = data.size;
              updateTextGeometry();
              textMaterial.color.set(data.color);
              updateSliderTrack(textSizeInput);
              const colorIndicator = document.getElementById('color-indicator');
              if (colorIndicator) colorIndicator.style.backgroundColor = data.color;
            }
            if (data.imagePath) {
              applyTexture(data.imagePath);
              imageBtn.textContent = "Update Image";
            } else {
              imageBtn.textContent = "Choose Image";
            }
          } s
        } catch (err) { console.error("Load failed:", err); }
      };

      textSizeInput.addEventListener('input', (e) => {
        updateSliderTrack(e.target);
        if (textGroup) {
          const val = (parseFloat(e.target.value) || 0.5) / 2;
          textGroup.scale.set(val, val, val);
        }
      });
      updateSliderTrack(textSizeInput);
      updateTextGeometry()

      // Event listener for the new "Apply Text" button
      applyTextBtn.addEventListener('click', () => {
        updateTextGeometry();
        saveCardData(textInput.value, colorPicker.value, textSizeInput.value);

        posthog.capture('Card Data Updated', {
          cardId: cardId,
          preset: presetName,
          type: 'text-change', // Differentiated name
          update_type: 'explicit_text_update',
          text: textInput.value
        });
      });

      colorPicker.addEventListener("input", () => {
        textMaterial.color.set(colorPicker.value);
        const colorIndicator = document.getElementById('color-indicator');
        if (colorIndicator) colorIndicator.style.backgroundColor = colorPicker.value;
        saveCardData(textInput.value, colorPicker.value, textSizeInput.value);

        captureColorChange(colorPicker.value);
      });

      const imageUpload = document.getElementById("image-upload");
      const cropperImage = document.getElementById("cropper-image");
      const cropperModal = document.getElementById("cropper-modal");

      imageUpload.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = (event) => {
            cropperImage.src = event.target.result;
            cropperModal.style.display = "flex";
            if (cropper) cropper.destroy();
            cropper = new Cropper(cropperImage, { aspectRatio: 1, viewMode: 1 });
          };
          reader.readAsDataURL(file);
        }
      });

      document.getElementById("crop-button").addEventListener("click", () => {
        if (!cropper) return;
        const size = 512;
        const croppedCanvas = cropper.getCroppedCanvas({ width: size, height: size });
        const circleCanvas = document.createElement("canvas");
        circleCanvas.width = size;
        circleCanvas.height = size;
        const ctx = circleCanvas.getContext("2d");
        ctx.clearRect(0, 0, size, size);
        ctx.save();
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(croppedCanvas, 0, 0, size, size);
        ctx.restore();
        circleCanvas.toBlob((blob) => uploadImage(blob));
      });

      document.getElementById("cancel-crop-button").addEventListener("click", () => {
        cropperModal.style.display = "none";
        if (cropper) cropper.destroy();
      });

      loadSavedData();
    });
  } catch (err) { console.error("Setup error:", err); };

  const startARButton = document.getElementById('start-ar-button');
  const startAROverlay = document.getElementById('start-ar-overlay');

  startARButton.addEventListener('click', async () => {
    try {
      await mindarThree.start();
      posthog.capture('AR Experience Started', { cardId: cardId });

      startAROverlay.style.display = 'none';
      const clock = new THREE.Clock();
      renderer.setAnimationLoop(() => {
        const delta = clock.getDelta();
        if (mixer) mixer.update(delta);
        renderer.render(scene, camera);
      });
      console.log("AR Experience Started");
    } catch (err) {
      console.error("Failed to start AR:", err);
    }
  });
});