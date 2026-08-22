// ============================================
// BIENENHAUS PROPIEDADES - Cloudinary Upload (firmado)
// ============================================
// Los uploads ya NO usan el preset unsigned. Flujo:
//   1. Pide firma al edge function cloudinary-sign (requiere
//      sesion de admin en Supabase).
//   2. Sube directo a Cloudinary con api_key + timestamp +
//      signature. El API secret nunca toca el navegador.
// ============================================

(function () {
  'use strict';

  /**
   * Token de la sesion admin activa (lo exige cloudinary-sign).
   */
  async function requireSessionToken() {
    if (!window.supabaseClient) {
      throw new Error('Supabase client no disponible');
    }
    const { data, error } = await window.supabaseClient.auth.getSession();
    if (error || !data?.session?.access_token) {
      throw new Error('Sesion requerida para subir imagenes');
    }
    return data.session.access_token;
  }

  /**
   * Pide firma + params al edge function cloudinary-sign.
   */
  async function requestUploadSignature(folder) {
    const token = await requireSessionToken();
    const url = `${window.BH_CONFIG.SUPABASE_URL}/functions/v1/cloudinary-sign`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ folder }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Firma rechazada (${res.status})`);
    }
    return res.json();
  }

  /**
   * Upload firmado a Cloudinary con auto WebP compression.
   * @param {File} file - The image file to upload.
   * @param {string} folder - Cloudinary folder (allowlist del server).
   * @returns {Promise<string>} The secure_url of the uploaded image.
   */
  async function uploadImage(file, folder = 'bienenhaus') {
    const sig = await requestUploadSignature(folder);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('api_key', sig.apiKey);
    formData.append('signature', sig.signature);
    for (const [key, value] of Object.entries(sig.params)) {
      formData.append(key, value);
    }

    const res = await fetch(`https://api.cloudinary.com/v1_1/${sig.cloudName}/image/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || 'Cloudinary upload failed');
    }

    const data = await res.json();
    /* Optimizacion delivery: f_auto,q_auto reemplaza al viejo
       fetch_format/quality de upload (no participan en la firma). */
    return data.secure_url.replace('/upload/', '/upload/f_auto,q_auto/');
  }

  /**
   * Upload multiple images in parallel.
   * @param {File[]} files
   * @param {string} folder
   * @returns {Promise<string[]>} Array of secure_urls.
   */
  async function uploadImages(files, folder = 'bienenhaus') {
    return Promise.all(Array.from(files).map(f => uploadImage(f, folder)));
  }

  // Expose globally
  window.BH_Cloudinary = { uploadImage, uploadImages };
})();
