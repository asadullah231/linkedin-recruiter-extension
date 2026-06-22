/**
 * BACKGROUND — n8n INTEGRATION
 * ─────────────────────────────
 *  - streamProfileToN8n(): push a single scraped profile to n8n immediately
 *    (live NocoDB row updates, one at a time).
 *  - sendBulkResultsToN8n(): legacy batch XLSX → n8n upload (kept for the
 *    manual "Send Now" flow; the live stream above is the default path).
 */

async function streamProfileToN8n(profileData) {
    const { n8nSettings = {} } = await chrome.storage.local.get('n8nSettings');
    const headers = { 'Content-Type': 'application/json' };
    if (n8nSettings.apiKey) headers['Authorization'] = `Bearer ${n8nSettings.apiKey}`;

    const res = await fetch(N8N_PROFILE_DONE_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            source: 'linkedin-recruiter-extension',
            version: '0.19.0',
            owner: n8nSettings.owner || '',   // ← who scraped this (for result tagging)
            timestamp: new Date().toISOString(),
            profile: profileData
        })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json().catch(() => ({}));
}

async function sendBulkResultsToN8n(settings, savedCount, skippedCount) {
    const profiles = await getAllProfiles();

    // Build XLSX binary using SheetJS
    let xlsxBlob = null;
    try {
        if (typeof XLSX === 'undefined') throw new Error('XLSX library not loaded');
        xlsxBlob = buildXlsxBlob(profiles);
        bulkLog(`📊 Built XLSX (${(xlsxBlob.size / 1024).toFixed(1)} KB)`, 'info');
    } catch (err) {
        bulkLog(`⚠️ XLSX build failed: ${err.message}. Falling back to JSON.`, 'error');
    }

    const profileUrls = profiles.map(p => p.profileUrl).filter(Boolean);
    const meta = {
        source: 'linkedin-recruiter-extension',
        version: '0.11.0',
        timestamp: new Date().toISOString(),
        saved: savedCount,
        skipped: skippedCount,
        total: bulkState.totalUrls,
        profileUrls
    };

    bulkLog(`📤 Auto-sending results to n8n: ${settings.callbackUrl}`, 'info');

    let res;
    if (xlsxBlob) {
        // Multipart upload: file + meta JSON
        const formData = new FormData();
        formData.append('file', xlsxBlob, `jobs-${Date.now()}.xlsx`);
        formData.append('meta', JSON.stringify(meta));
        formData.append('profiles', JSON.stringify(profiles));

        const headers = {};
        if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;

        res = await fetch(settings.callbackUrl, {
            method: 'POST',
            headers,
            body: formData
        });
    } else {
        // Fallback: JSON only (no XLSX)
        const headers = { 'Content-Type': 'application/json' };
        if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;
        res = await fetch(settings.callbackUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...meta, run: { saved: savedCount, skipped: skippedCount, total: bulkState.totalUrls }, profiles })
        });
    }

    if (res.ok) {
        bulkLog(`✅ n8n callback OK (HTTP ${res.status})`, 'success');
    } else {
        bulkLog(`⚠️ n8n callback HTTP ${res.status}`, 'error');
    }
}
