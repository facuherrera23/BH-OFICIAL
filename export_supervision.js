// ===== EXPORT SUPERVISION =====
  async function exportSupervision(type) {
    const session = await window.supabaseClient.auth.getSession();
    const token = session.data.session?.access_token;
    if (!token) return;

    try {
      const url = `${window.BH_CONFIG.SUPABASE_URL}/functions/v1/supervision-api/export?type=${type}&format=csv`;
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Error al exportar');

      const blob = await res.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `supervision_${type}_${new Date().toISOString().slice(0,10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(downloadUrl);

      // Audit the export
      await fetch(`${window.BH_CONFIG.SUPABASE_URL}/functions/v1/supervision-api/export`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type })
      });

      showToast(`Exportación ${type.toUpperCase()} completada`, 'success');
    } catch (err) {
      showToast('Error al exportar: ' + err.message, 'error');
    }
  }

// ===== VISTA ML DASHBOARD =====