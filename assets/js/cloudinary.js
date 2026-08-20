// ============================================
// BIENENHAUS PROPIEDADES - Cloudinary Upload
// ============================================

(function () {
  'use strict';

  const { cloud_name, upload_preset, upload_url } = window.BH_CONFIG.CLOUDINARY;

  /**
   * Upload image to Cloudinary with auto WebP compression.
   * @param {File} file - The image file to upload.
   * @param {string} folder - Cloudinary folder.
   * @returns {Promise<string>} The secure_url of the uploaded image.
   */
  async function uploadImage(file, folder = 'bienenhaus') {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', upload_preset);
    formData.append('folder', folder);
    formData.append('quality', 'auto');
    formData.append('fetch_format', 'auto');
    formData.append('resource_type', 'image');

    const res = await fetch(upload_url, {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || 'Cloudinary upload failed');
    }

    const data = await res.json();
    return data.secure_url;
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
