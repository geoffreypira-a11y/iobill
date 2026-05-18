// src/lib/upload-compress.js
//
// Compression côté frontend avant upload Supabase Storage.
// Objectif : économiser le quota Storage (Free = 1 GB).
//
// Stratégie :
//   - Images (jpg/png/heic/webp) : canvas resize + recompression JPEG 75%
//     → divise typiquement par 4-8 la taille (photo iPhone 4 MB → ~600 KB)
//   - PDF : on ne compresse pas (pdf-lib trop lourd côté front),
//     mais on rejette les fichiers > 5 MB avec message utilisateur
//   - Autres : passthrough (pas de modif)

const MAX_DIMENSION = 2000;       // largeur/hauteur max pour les photos
const JPEG_QUALITY = 0.75;        // 75% — bon compromis qualité/taille
const MAX_PDF_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Compresse un fichier avant upload. Retourne un nouveau File ou le même
 * si pas de compression applicable.
 *
 * @returns {Promise<{file: File, originalSize: number, newSize: number, ratio: number}>}
 * @throws {Error} avec message utilisateur si le fichier doit être rejeté
 */
export async function compressForUpload(file) {
  const originalSize = file.size;

  // 1) PDF : limite stricte sans transformation
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    if (originalSize > MAX_PDF_BYTES) {
      throw new Error(
        `PDF trop volumineux (${Math.round(originalSize / 1024 / 1024)} MB). ` +
        `Limite : 5 MB. Astuce : utilisez un outil comme ilovepdf.com/fr/compresser_pdf pour le compresser.`
      );
    }
    return { file, originalSize, newSize: originalSize, ratio: 1 };
  }

  // 2) Image : canvas resize + JPEG
  if (file.type.startsWith("image/") || /\.(jpe?g|png|heic|heif|webp)$/i.test(file.name)) {
    try {
      const compressed = await compressImage(file);
      return {
        file: compressed,
        originalSize,
        newSize: compressed.size,
        ratio: originalSize > 0 ? compressed.size / originalSize : 1
      };
    } catch (e) {
      // Si la compression échoue (HEIC pas supporté par certains browsers, etc.),
      // on remonte le fichier original
      console.warn("[compress] échec compression image, upload tel quel:", e?.message);
      return { file, originalSize, newSize: originalSize, ratio: 1 };
    }
  }

  // 3) Autres formats : passthrough
  return { file, originalSize, newSize: originalSize, ratio: 1 };
}

/**
 * Compresse une image via canvas. Resize si > MAX_DIMENSION puis encode JPEG.
 */
async function compressImage(file) {
  // Charger l'image
  const dataUrl = await readAsDataURL(file);
  const img = await loadImage(dataUrl);

  // Calculer dimensions cibles
  let { width, height } = img;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    if (width > height) {
      height = Math.round(height * (MAX_DIMENSION / width));
      width = MAX_DIMENSION;
    } else {
      width = Math.round(width * (MAX_DIMENSION / height));
      height = MAX_DIMENSION;
    }
  }

  // Dessiner dans canvas
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; // fond blanc pour les PNG transparents
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  // Encoder en JPEG
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => b ? resolve(b) : reject(new Error("toBlob failed")),
      "image/jpeg",
      JPEG_QUALITY
    );
  });

  // Renommer pour cohérence (.jpg)
  const newName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
  return new File([blob], newName, { type: "image/jpeg", lastModified: Date.now() });
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image load failed"));
    img.src = src;
  });
}

/**
 * Format human-readable d'une taille en bytes.
 */
export function fmtBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}
