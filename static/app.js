let __prevViewName = null;

const LEADERBOARD_CACHE_TTL_MS = 30000;
let __leaderboardCache = { at: 0, payload: null };

/** Sent once with the next chat message; cleared after POST /api/chat */
let currentChatReceiptContext = null;

function showToast(message, type = 'info') {
    const c = document.getElementById('toast-container');
    if (!c || !message) return;
    const t = document.createElement('div');
    const safeType = type === 'error' ? 'error' : type === 'success' ? 'success' : 'info';
    t.className = `ec-toast ec-toast--${safeType}`;
    t.setAttribute('role', 'status');
    t.textContent = message;
    c.appendChild(t);
    requestAnimationFrame(() => t.classList.add('ec-toast--show'));
    setTimeout(() => {
        t.classList.remove('ec-toast--show');
        t.classList.add('ec-toast--hide');
        setTimeout(() => t.remove(), 420);
    }, 3000);
}

function setDashboardLoading(loading) {
    const hsk = document.getElementById('dashboard-habits-skeleton');
    const hbody = document.getElementById('dashboard-habits-body');
    if (loading) {
        if (hsk) hsk.hidden = false;
        if (hbody) hbody.hidden = true;
    } else {
        if (hsk) hsk.hidden = true;
        if (hbody) hbody.hidden = false;
    }
}

function showUploadProgress(container) {
    if (!container) {
        return {
            complete() {},
            cancel() {},
        };
    }
    const steps = [
        { label: 'Uploading receipt', icon: '📤', duration: 800 },
        { label: 'AI reading your receipt', icon: '🔍', duration: 2500 },
        { label: 'Identifying items & brands', icon: '🏷️', duration: 2000 },
        { label: 'Calculating carbon footprint', icon: '🌍', duration: 1500 },
        { label: 'Preparing your results', icon: '✨', duration: 800 },
    ];

    container.innerHTML = `
        <div class="card" style="padding:32px 24px; text-align:center;">
            <div style="margin-bottom:24px;">
                <div class="upload-spinner" role="status" aria-label="Loading"></div>
            </div>
            <div id="upload-step-label" style="font-family:'Outfit',sans-serif; font-size:1.1em; font-weight:600; color:#132a13; margin-bottom:8px;">
                ${steps[0].icon} ${escapeHtml(steps[0].label)}…
            </div>
            <div id="upload-step-subtext" style="font-size:0.85em; color:#9ca3af; margin-bottom:24px;">
                This usually takes 5-10 seconds
            </div>
            <div style="background:#e8e3d8; border-radius:8px; height:8px; width:100%; max-width:360px; margin:0 auto 20px; overflow:hidden;">
                <div id="upload-progress-bar" style="background:linear-gradient(90deg, #4f772d, #90a955); height:100%; border-radius:8px; width:0%; transition:width 0.5s ease;"></div>
            </div>
            <div id="upload-steps" style="display:flex; justify-content:center; gap:6px; margin-top:16px; flex-wrap:wrap;">
                ${steps
                    .map(
                        (s, i) =>
                            `<div class="upload-step-dot" data-step="${i}" style="width:10px; height:10px; border-radius:50%; background:#d3e0d4; transition:background 0.3s, transform 0.3s;" title="${escapeHtml(
                                s.label
                            )}"></div>`
                    )
                    .join('')}
            </div>
        </div>`;

    container.style.display = 'block';

    let currentStep = 0;
    let progressCancelled = false;

    function advanceStep() {
        if (progressCancelled) return;
        if (currentStep >= steps.length) return;

        const step = steps[currentStep];
        const label = document.getElementById('upload-step-label');
        const bar = document.getElementById('upload-progress-bar');
        const subtext = document.getElementById('upload-step-subtext');
        const dots = container.querySelectorAll('.upload-step-dot');

        if (label) label.innerHTML = `${step.icon} ${escapeHtml(step.label)}…`;

        if (subtext) {
            const subtexts = [
                'Sending your image securely…',
                'Gemini AI is scanning every line…',
                'Matching products to real brands…',
                'Looking up emission factors for each item…',
                'Almost there!',
            ];
            subtext.textContent = subtexts[currentStep] || '';
        }

        const progress = Math.round(((currentStep + 1) / steps.length) * 100);
        if (bar) bar.style.width = `${progress}%`;

        dots.forEach((dot, i) => {
            if (i < currentStep) {
                dot.style.background = '#4f772d';
                dot.style.transform = 'scale(1)';
            } else if (i === currentStep) {
                dot.style.background = '#90a955';
                dot.style.transform = 'scale(1.4)';
            } else {
                dot.style.background = '#d3e0d4';
                dot.style.transform = 'scale(1)';
            }
        });

        currentStep += 1;

        if (currentStep < steps.length) {
            setTimeout(advanceStep, step.duration);
        }
    }

    advanceStep();

    return {
        complete() {
            progressCancelled = true;
            const bar = document.getElementById('upload-progress-bar');
            const label = document.getElementById('upload-step-label');
            const subtext = document.getElementById('upload-step-subtext');
            const dots = container.querySelectorAll('.upload-step-dot');

            if (bar) bar.style.width = '100%';
            if (label) label.innerHTML = '✅ Analysis complete!';
            if (subtext) subtext.textContent = '';
            dots.forEach((dot) => {
                dot.style.background = '#4f772d';
                dot.style.transform = 'scale(1)';
            });
        },
        cancel() {
            progressCancelled = true;
        },
    };
}

function renderUploadErrorFeedback(message) {
    const feedback = document.getElementById('ai-feedback');
    if (!feedback) return;
    const msg = message || 'Something went wrong. Please try again.';
    feedback.style.display = 'block';
    feedback.innerHTML = `
        <div class="card" style="padding:24px; text-align:center;">
            <div style="font-size:2em; margin-bottom:12px;">❌</div>
            <div style="font-weight:600; color:#ef4444; margin-bottom:8px;">Upload Failed</div>
            <div style="color:#6b7280; font-size:0.9em; margin-bottom:16px;">${escapeHtml(msg)}</div>
            <button type="button" class="btn btn-primary" onclick="window.resetLogView && window.resetLogView()" style="padding:8px 20px; border-radius:8px; font-family:'Outfit',sans-serif; font-weight:600;">Try Again</button>
        </div>`;
}

function switchView(viewName) {
    const smViews = ['supermarket', 'store', '3d'];
    if (
        smViews.includes(__prevViewName) &&
        !smViews.includes(viewName) &&
        typeof window.stopSupermarketRender === 'function'
    ) {
        window.stopSupermarketRender();
    }

    // Hide all sections
    document.querySelectorAll('.view-section').forEach(section => {
        section.classList.remove('active');
    });

    // Show the target section
    const targetSection = document.getElementById(`view-${viewName}`);
    if (targetSection) {
        targetSection.classList.add('active');
    }
    
    // Update active state in nav
    document.querySelectorAll('.nav-link').forEach((link) => {
        link.classList.toggle('active', link.dataset.view === viewName);
    });
    document.querySelectorAll('.mobile-tab-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.view === viewName);
    });

    if (viewName === 'log') {
        initUpload();
        resetLogView();
    }

    if (viewName === 'dashboard') {
        removeDashboardStatSkeletonGhosts();
        void refreshDashboardData().then(() => loadBadges());
    }

    if (viewName === 'leaderboard') {
        loadLeaderboard();
    }

    if (viewName === 'supermarket' || viewName === 'store' || viewName === '3d') {
        setTimeout(() => {
            if (typeof window.initSupermarket === 'function') {
                window.initSupermarket();
            } else {
                console.error('initSupermarket not available — check supermarket3d.js / import map');
            }
        }, 60);
    }

    if (viewName === 'history') {
        initHistoryViewIfNeeded();
    }

    if (viewName === 'smartlist') {
        loadSmartList();
    }

    if (viewName !== 'history') {
        window.__chatFocusedReceiptId = null;
        document.querySelectorAll('.history-receipt-card.is-focused').forEach((el) => {
            el.classList.remove('is-focused');
        });
    }

    // Re-create icons for new content
    if (window.lucide) {
        window.lucide.createIcons();
    }

    __prevViewName = viewName;
}

// === SMART LIST ===
let smartListData = null;

function loadSmartList() {
    const content = document.getElementById('sl-content');
    const statsEl = document.getElementById('sl-stats');
    if (content) {
        content.innerHTML = `<div style="text-align:center; padding:60px 20px; color:#9ca3af;">
            <div class="spinner lg" style="margin:0 auto;" role="status" aria-label="Loading"></div>
            <p style="margin-top:12px;">Building your smart list...</p>
        </div>`;
    }
    if (statsEl) statsEl.innerHTML = '';

    fetch('/api/smart-list')
        .then((res) => res.json())
        .then((data) => {
            if (data.error) {
                throw new Error(data.error);
            }
            smartListData = data;
            renderSmartListStats(
                data.stats || {
                    total_items: 0,
                    original_co2: 0,
                    optimized_co2: 0,
                    total_saved: 0,
                    swap_count: 0,
                }
            );
            renderSmartList(data);
            if (window.lucide) window.lucide.createIcons();
        })
        .catch((err) => {
            console.error('Smart list error:', err);
            if (content) {
                content.innerHTML = `<div style="text-align:center;padding:40px;color:var(--accent, #ef4444);">Failed to load smart list.</div>`;
            }
        });
}

function renderSmartListStats(stats) {
    const container = document.getElementById('sl-stats');
    if (!container) return;

    const s = stats || {};
    const orig = Number(s.original_co2 ?? 0);
    const opt = Number(s.optimized_co2 ?? 0);
    const saved = Number(s.total_saved ?? 0);
    const n = Number(s.total_items ?? 0);

    const cards = [
        { label: 'List Items', value: String(n), icon: 'shopping-cart', color: '#4f772d' },
        { label: 'Original CO₂', value: `${orig.toFixed(1)} kg`, icon: 'cloud', color: '#ef4444' },
        { label: 'Optimized CO₂', value: `${opt.toFixed(1)} kg`, icon: 'leaf', color: '#22c55e' },
        { label: 'CO₂ Saved', value: `${saved.toFixed(1)} kg`, icon: 'trending-down', color: '#3b82f6' },
    ];

    container.innerHTML = cards
        .map(
            (c) => `
        <div class="card" style="padding:16px; text-align:center;">
            <i data-lucide="${c.icon}" style="width:20px;height:20px;color:${c.color};margin-bottom:6px;"></i>
            <div style="font-size:1.5em; font-weight:700; color:#132a13;">${escapeHtml(c.value)}</div>
            <div style="font-size:0.8em; color:#6b7280; margin-top:2px;">${escapeHtml(c.label)}</div>
        </div>`
        )
        .join('');
}

function renderSmartList(data) {
    const container = document.getElementById('sl-content');
    if (!container) return;

    if (!data.smart_list || data.smart_list.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding:60px 20px;">
                <i data-lucide="clipboard-list" style="width:48px;height:48px;color:#d3e0d4;margin-bottom:16px;"></i>
                <h3 style="color:#132a13; margin-bottom:8px;">No Shopping Data Yet</h3>
                <p style="color:#6b7280; margin-bottom:20px;">${escapeHtml(
                    data.message || 'Upload a few receipts and your smart list will appear here.'
                )}</p>
                <button type="button" class="btn btn-primary js-sl-goto-upload" style="padding:10px 24px;background:#4f772d;color:white;border:none;border-radius:8px;cursor:pointer;font-family:'Outfit',sans-serif;font-weight:600;">Upload Receipt</button>
            </div>`;
        return;
    }

    const categories = data.by_category || {};
    const categoryOrder = [
        'Meat',
        'Dairy',
        'Produce',
        'Beverages',
        'Grains',
        'Snacks',
        'Frozen',
        'Household',
        'Other',
    ];
    const categoryColors = {
        Meat: '#ef4444',
        Dairy: '#f59e0b',
        Produce: '#22c55e',
        Beverages: '#3b82f6',
        Grains: '#a855f7',
        Snacks: '#f97316',
        Frozen: '#a78bfa',
        Household: '#6b7280',
        Other: '#9ca3af',
    };
    const categoryEmoji = {
        Meat: '🥩',
        Dairy: '🧀',
        Produce: '🥬',
        Beverages: '🥤',
        Grains: '🍞',
        Snacks: '🍪',
        Frozen: '🧊',
        Household: '🧹',
        Other: '📦',
    };

    let html = '';

    const sortedCats = Object.keys(categories).sort((a, b) => {
        const ia = categoryOrder.indexOf(a);
        const ib = categoryOrder.indexOf(b);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

    for (const cat of sortedCats) {
        const items = categories[cat];
        if (!items || items.length === 0) continue;

        const color = categoryColors[cat] || '#6b7280';
        const emoji = categoryEmoji[cat] || '📦';

        html += `
            <div style="margin-bottom:24px;">
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px; padding-bottom:8px; border-bottom:2px solid ${color}33;">
                    <span style="font-size:1.2em;">${emoji}</span>
                    <h3 style="margin:0; font-size:1em; font-weight:700; color:#132a13;">${escapeHtml(cat)}</h3>
                    <span style="font-size:0.8em; color:#9ca3af; margin-left:auto;">${items.length} item${
                        items.length > 1 ? 's' : ''
                    }</span>
                </div>
                <div style="display:flex; flex-direction:column; gap:8px;">`;

        for (const item of items) {
            const isSwapped = item.swapped && item.swap_to;
            const co2Display = isSwapped ? item.swapped_co2 : item.avg_co2;
            const co2Num = Number(co2Display ?? 0);
            const co2Color = co2Num > 5 ? '#ef4444' : co2Num < 1.5 ? '#22c55e' : '#f59e0b';
            const isReg = Boolean(item.is_regular);
            const freqBorder = isReg ? '#4f772d' : '#d3e0d4';
            const freqBg = isReg ? '#f0fdf4' : '#f9fafb';
            const freqColor = isReg ? '#166534' : '#9ca3af';
            const freqLabel = isReg ? '🔄 Regular' : '1️⃣ One-time';
            const brandLine = isSwapped
                ? escapeHtml(item.swap_to.brand || '')
                : escapeHtml(item.brand || '');

            html += `
                <div class="card" style="padding:14px 16px; display:flex; align-items:center; gap:12px; ${
                    isSwapped ? 'border-left:3px solid #22c55e;' : ''
                }">
                    <input type="checkbox" class="sl-item-check" data-item-id="${escapeHtml(item.id)}" ${
                        item.included ? 'checked' : ''
                    } style="width:18px; height:18px; accent-color:#4f772d; cursor:pointer; flex-shrink:0;">
                    <div style="flex:1; min-width:0;">
                        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                            ${
                                isSwapped
                                    ? `<span style="text-decoration:line-through; color:#9ca3af; font-size:0.9em;">${escapeHtml(
                                          item.item_name
                                      )}</span>
                                <i data-lucide="arrow-right" style="width:14px;height:14px;color:#22c55e;flex-shrink:0;"></i>
                                <span style="font-weight:600; color:#166534;">${escapeHtml(
                                    item.swap_to.product || ''
                                )}</span>`
                                    : `<span style="font-weight:600; color:#132a13;">${escapeHtml(
                                          item.item_name || ''
                                      )}</span>`
                            }
                        </div>
                        <div style="display:flex; align-items:center; gap:8px; margin-top:4px; flex-wrap:wrap;">
                            <span style="font-size:0.8em; color:#6b7280;">${brandLine}</span>
                            <button type="button" class="sl-freq-toggle" data-item-id="${escapeHtml(item.id)}"
                                onclick="toggleItemFrequency('${item.id}')"
                                style="font-size:0.75em; padding:2px 8px; border-radius:6px; border:1px solid ${freqBorder};
                                background:${freqBg}; color:${freqColor}; cursor:pointer; font-family:'Outfit',sans-serif;
                                transition:all 0.2s; display:inline-flex; align-items:center; gap:4px;">${freqLabel}</button>
                            ${
                                item.avg_quantity > 1
                                    ? `<span style="font-size:0.75em; color:#9ca3af;">Qty: ${escapeHtml(
                                          String(item.avg_quantity)
                                      )} ${escapeHtml(item.unit || '')}</span>`
                                    : ''
                            }
                            ${
                                isSwapped
                                    ? `<span style="font-size:0.75em; background:#f0fdf4; color:#166534; padding:2px 6px; border-radius:4px;">saves ${escapeHtml(
                                          String(item.swap_to.co2_savings)
                                      )} kg</span>`
                                    : ''
                            }
                        </div>
                    </div>
                    <div style="text-align:right; flex-shrink:0;">
                        <div style="font-weight:700; color:${co2Color}; font-size:1.1em;">${co2Num.toFixed(2)}</div>
                        <div style="font-size:0.7em; color:#9ca3af;">kg CO₂e</div>
                    </div>
                </div>`;
        }

        html += '</div></div>';
    }

    container.innerHTML = html;
}

function recalcSmartListStats() {
    if (!smartListData) return;
    const included = (smartListData.smart_list || []).filter((i) => i.included);
    smartListData.stats = smartListData.stats || {};
    smartListData.stats.total_items = included.length;
    smartListData.stats.original_co2 =
        Math.round(included.reduce((s, i) => s + Number(i.avg_co2 || 0), 0) * 100) / 100;
    smartListData.stats.optimized_co2 =
        Math.round(
            included.reduce((s, i) => s + Number(i.swapped_co2 != null ? i.swapped_co2 : i.avg_co2 || 0), 0) * 100
        ) / 100;
    smartListData.stats.total_saved =
        Math.round((smartListData.stats.original_co2 - smartListData.stats.optimized_co2) * 100) / 100;
    smartListData.stats.swap_count = included.filter((i) => i.swapped).length;
}

function toggleItemFrequency(itemId) {
    if (!smartListData?.smart_list) return;

    const item = smartListData.smart_list.find((i) => i.id === itemId);
    if (!item) return;

    item.is_regular = !item.is_regular;
    if (item.is_regular && !item.included) {
        item.included = true;
    }

    const btn = document.querySelector(`.sl-freq-toggle[data-item-id="${CSS.escape(itemId)}"]`);
    if (btn) {
        if (item.is_regular) {
            btn.innerHTML = '🔄 Regular';
            btn.style.border = '1px solid #4f772d';
            btn.style.background = '#f0fdf4';
            btn.style.color = '#166534';
        } else {
            btn.innerHTML = '1️⃣ One-time';
            btn.style.border = '1px solid #d3e0d4';
            btn.style.background = '#f9fafb';
            btn.style.color = '#9ca3af';
        }
    }

    const cb = document.querySelector(`.sl-item-check[data-item-id="${CSS.escape(itemId)}"]`);
    if (cb) cb.checked = Boolean(item.included);

    recalcSmartListStats();
    renderSmartListStats(smartListData.stats);
}

function toggleSmartListItem(itemId, checked) {
    if (!smartListData?.smart_list) return;
    const item = smartListData.smart_list.find((i) => i.id === itemId);
    if (item) {
        item.included = checked;
        recalcSmartListStats();
        renderSmartListStats(smartListData.stats);
    }
}

function optimizeSmartList() {
    if (!smartListData || !smartListData.smart_list) return;

    const btn = document.getElementById('sl-optimize-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML =
            '<span style="display:inline-flex;align-items:center;gap:8px;"><span class="spinner sm" aria-hidden="true"></span> Analyzing your list…</span>';
    }

    const payload = smartListData.smart_list.map((i) => ({
        item_name: i.item_name,
        brand: i.brand,
        category: i.category,
        avg_co2: i.avg_co2,
        included: Boolean(i.included),
        swapped: Boolean(i.swapped),
    }));

    fetch('/api/smart-list/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: payload }),
    })
        .then((res) => res.json())
        .then((data) => {
            if (data.error && (!data.suggestions || !data.suggestions.length)) {
                throw new Error(data.error);
            }
            if (data.suggestions && data.suggestions.length > 0) {
                let appliedCount = 0;

                for (const suggestion of data.suggestions) {
                    const origName = (suggestion.original_product || '').toLowerCase().trim();
                    const origBrand = (suggestion.original_brand || '').toLowerCase().trim();

                    const item = smartListData.smart_list.find((i) => {
                        if (!i.included || i.swapped) return false;
                        const iname = (i.item_name || '').toLowerCase();
                        const ibrand = (i.brand || '').toLowerCase();
                        const nameMatch = Boolean(
                            origName && iname && (iname.includes(origName) || origName.includes(iname))
                        );
                        const brandMatch =
                            origBrand &&
                            ibrand &&
                            (ibrand.includes(origBrand) || origBrand.includes(ibrand));
                        return nameMatch || brandMatch;
                    });

                    if (item) {
                        item.swapped = true;
                        item.swap_to = {
                            product: suggestion.recommended_product,
                            brand: suggestion.recommended_brand,
                            co2_savings: Number(suggestion.co2_savings || 0),
                            reason: suggestion.reason || '',
                            aisle_location: suggestion.aisle_location || '',
                        };
                        item.swapped_co2 =
                            Math.round(
                                Math.max(0.1, Number(item.avg_co2 || 0) - Number(suggestion.co2_savings || 0)) * 100
                            ) / 100;
                        appliedCount++;
                    }
                }

                recalcSmartListStats();
                renderSmartListStats(smartListData.stats);
                renderSmartList(smartListData);
                if (window.lucide) window.lucide.createIcons();

                if (typeof showToast === 'function') {
                    showToast(`${appliedCount} items swapped to greener alternatives! 🌱`, 'success');
                }
            } else if (typeof showToast === 'function') {
                showToast(data.message || 'Your list is already well optimized!', 'info');
            }
        })
        .catch((err) => {
            console.error('Optimize error:', err);
            if (typeof showToast === 'function') {
                showToast('Optimization failed. Please try again.', 'error');
            }
        })
        .finally(() => {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML =
                    '<i data-lucide="sparkles" style="width:16px;height:16px;"></i> Optimize with AI';
                if (window.lucide) window.lucide.createIcons();
            }
        });
}

function copySmartList() {
    if (!smartListData) return;

    const included = smartListData.smart_list.filter((i) => i.included);
    const regulars = included.filter((i) => i.is_regular);
    const oneTimers = included.filter((i) => !i.is_regular);

    const st = smartListData.stats || {};
    let text = '🛒 My EcoCart Smart Grocery List\n';
    text += `🌱 Optimized CO₂: ${Number(st.optimized_co2 ?? 0).toFixed(1)} kg\n`;
    text += `💚 CO₂ Saved: ${Number(st.total_saved ?? 0).toFixed(1)} kg\n\n`;

    const lineFor = (i) => {
        const name =
            i.swapped && i.swap_to
                ? `${i.swap_to.product} (${i.swap_to.brand || ''})`
                : `${i.item_name} (${i.brand || ''})`;
        const qty = i.avg_quantity > 1 ? ` ×${i.avg_quantity}` : '';
        return `  ☐ ${name}${qty}`;
    };

    if (regulars.length > 0) {
        text += '🔄 REGULARS:\n';
        text += regulars.map(lineFor).join('\n');
        text += '\n\n';
    }

    if (oneTimers.length > 0) {
        text += '1️⃣ ONE-TIME:\n';
        text += oneTimers.map(lineFor).join('\n');
    }

    const done = () => {
        if (typeof showToast === 'function') {
            showToast('Grocery list copied to clipboard!', 'success');
        }
    };

    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            done();
        });
    } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        done();
    }
}

window.toggleItemFrequency = toggleItemFrequency;

function findItemsInStore() {
    if (!smartListData?.smart_list) return;

    const included = smartListData.smart_list.filter((i) => i.included);
    const itemNames = included.map((i) =>
        i.swapped && i.swap_to ? i.swap_to.product : i.item_name
    );

    window.smartListItemsForStore = itemNames.filter(Boolean);
    switchView('supermarket');

    if (typeof showToast === 'function') {
        showToast(`Loading ${itemNames.length} items in 3D store…`, 'info');
    }
}

// Reset the Log View UI
function resetLogView() {
    const feedback = document.getElementById('ai-feedback');
    if (!feedback) return;
    feedback.style.display = 'none';
    feedback.innerHTML = '';
}

// Global Refresh Suite
async function refreshAllData() {
    __leaderboardCache.at = 0;
    await Promise.all([
        refreshDashboardData(),
        refreshHistoryView()
    ]);
    const dash = document.getElementById('view-dashboard');
    if (dash && dash.classList.contains('active')) {
        loadBadges();
    }
}

// File Upload Logic
function initUpload() {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);

    dropZone.onclick = () => fileInput.click();

    fileInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const formData = new FormData();
        formData.append('file', file);

        const feedback = document.getElementById('ai-feedback');
        if (!feedback) return;
        feedback.style.display = 'block';
        feedback.scrollIntoView({ behavior: 'smooth' });

        const progressUi = showUploadProgress(feedback);

        try {
            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData,
            });
            let result;
            try {
                result = await response.json();
            } catch (parseErr) {
                progressUi.cancel();
                renderUploadErrorFeedback('Invalid server response');
                showToast('Upload failed: invalid server response', 'error');
                return;
            }

            if (!response.ok) {
                throw new Error(result.error || `Upload failed: ${response.status}`);
            }

            if (result.status === 'success') {
                progressUi.complete();
                const pts = result.points_awarded || result.points || 0;
                const p = Number(pts) || 0;
                setTimeout(() => {
                    if (p > 0) {
                        showToast(`Receipt uploaded successfully! +${p} pts`, 'success');
                    } else {
                        showToast('Receipt uploaded successfully!', 'success');
                    }
                    displayAIResults(result);
                }, 600);
            } else {
                throw new Error(result.error || 'Upload failed');
            }
        } catch (err) {
            console.error(err);
            progressUi.cancel();
            renderUploadErrorFeedback(err.message || 'Something went wrong. Please try again.');
            showToast(err.message || 'An error occurred during upload.', 'error');
        } finally {
            fileInput.value = '';
        }
    };
}

function escapeHtml(s) {
    if (s == null || s === '') return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

function escapeAttr(s) {
    if (s == null || s === '') return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
}

function categoryIcon(cat) {
    const c = (cat || '').toLowerCase();
    if (c === 'meat') return '🥩';
    if (c === 'dairy') return '🥛';
    if (c === 'produce') return '🥬';
    if (c === 'beverages') return '🥤';
    if (c === 'grains') return '🌾';
    if (c === 'snacks') return '🍿';
    if (c === 'frozen') return '🧊';
    if (c === 'household') return '🧹';
    if (c === 'food') return '🍽️';
    if (c === 'transport') return '🚗';
    if (c === 'energy') return '⚡';
    return '🛒';
}

function categorySlug(cat) {
    let s = String(cat || 'other')
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]+/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    if (!s) s = 'other';
    return s;
}

function getGreetingWord() {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
}

function getEcoLevel(points) {
    const p = Math.max(0, Number(points) || 0);
    if (p <= 100) return { title: 'Seedling 🌱', nextAt: 101, start: 0, span: 100 };
    if (p <= 500) return { title: 'Sprout 🌿', nextAt: 501, start: 100, span: 400 };
    if (p <= 1000) return { title: 'Sapling 🌳', nextAt: 1001, start: 500, span: 500 };
    if (p <= 2500) return { title: 'Evergreen 🌲', nextAt: 2501, start: 1000, span: 1500 };
    return { title: 'Guardian 🛡️', nextAt: null, start: 2501, span: null };
}

function levelProgressPercent(points) {
    const info = getEcoLevel(points);
    if (info.nextAt == null) return 100;
    const into = points - info.start;
    return Math.min(100, Math.max(0, (into / info.span) * 100));
}

function nextLevelLabel(points) {
    const info = getEcoLevel(points);
    if (!info.nextAt) return 'You reached Guardian — keep earning EcoPoints!';
    const need = Math.max(0, info.nextAt - points);
    if (points <= 100) return `${need} EcoPoints to Sprout 🌿`;
    if (points <= 500) return `${need} EcoPoints to Sapling 🌳`;
    if (points <= 1000) return `${need} EcoPoints to Evergreen 🌲`;
    if (points <= 2500) return `${need} EcoPoints to Guardian 🛡️`;
    return 'You reached Guardian — keep earning EcoPoints!';
}

function updateLevelUI(points, streakCount) {
    const p = Number(points) || 0;
    const info = getEcoLevel(p);
    const pill = document.getElementById('dash-level-pill');
    if (pill) pill.textContent = info.title;
    const fill = document.getElementById('dash-level-progress-fill');
    if (fill) fill.style.width = `${levelProgressPercent(p)}%`;
    const cap = document.getElementById('dash-level-next');
    if (cap) cap.textContent = nextLevelLabel(p);

    const sbFill = document.getElementById('sidebar-level-fill');
    if (sbFill) sbFill.style.width = `${levelProgressPercent(p)}%`;

    const sbLevel = document.getElementById('sidebar-level-line');
    if (sbLevel) sbLevel.textContent = info.title;
    const sbPts = document.getElementById('sidebar-points-line');
    if (sbPts) sbPts.textContent = `${p} EcoPoints`;
    const sbStreakText = document.getElementById('sidebar-streak-text');
    const sbFire = document.getElementById('sidebar-streak-fire');
    const sc = Number(streakCount) || 0;
    if (sbStreakText) sbStreakText.textContent = `${sc} day streak`;
    if (sbFire) {
        if (sc > 0) {
            sbFire.style.display = 'inline-block';
            const scale = 1 + Math.min(sc, 21) * 0.022;
            sbFire.style.transform = `scale(${scale})`;
        } else {
            sbFire.style.display = 'none';
        }
    }
}

function levelNameWithEmoji(levelName) {
    const m = {
        Seedling: 'Seedling 🌱',
        Sprout: 'Sprout 🌿',
        Sapling: 'Sapling 🌳',
        Evergreen: 'Evergreen 🌲',
        Guardian: 'Guardian 🛡️',
    };
    return m[levelName] || levelName;
}

function showPointsFloater(amount) {
    const n = Number(amount) || 0;
    if (n === 0) return;
    const anchor =
        document.getElementById('sidebar-points-line') ||
        document.querySelector('.user-profile');
    const target = anchor && anchor.closest('.user-profile') ? anchor.closest('.user-profile') : anchor;
    const targetEl = target || document.body;
    if (targetEl && getComputedStyle(targetEl).position === 'static') {
        targetEl.style.position = 'relative';
    }
    const el = document.createElement('span');
    el.className = 'points-floater';
    el.textContent = n > 0 ? `+${n} pts` : `${n} pts`;
    targetEl.appendChild(el);
    requestAnimationFrame(() => el.classList.add('points-floater--animate'));
    setTimeout(() => el.remove(), 1600);
}

function animateStatCountUp(el, target, decimals, suffixHtml) {
    if (!el) return;
    const end = Number(target) || 0;
    const t0 = performance.now();
    const duration = 800;
    function tick(now) {
        const t = Math.min(1, (now - t0) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        const val = end * eased;
        const txt = decimals === 0 ? String(Math.round(val)) : val.toFixed(decimals);
        el.innerHTML = txt + (suffixHtml || '');
        if (t < 1) requestAnimationFrame(tick);
        else {
            const finalTxt = decimals === 0 ? String(Math.round(end)) : end.toFixed(decimals);
            el.innerHTML = finalTxt + (suffixHtml || '');
        }
    }
    requestAnimationFrame(tick);
}

function animateHabitBarsDeferred() {
    const root = document.getElementById('view-dashboard');
    if (!root) return;
    const fills = root.querySelectorAll('.habit-fill');
    fills.forEach((f) => {
        f.style.width = '0%';
        f.style.transitionDelay = '0s';
    });
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            fills.forEach((f, i) => {
                f.style.transitionDelay = `${i * 0.07}s`;
                const pct = parseFloat(f.getAttribute('data-pct'));
                if (!Number.isNaN(pct)) f.style.width = `${Math.min(100, pct)}%`;
            });
        });
    });
}

function animateWeeklyBarsDeferred() {
    const root = document.getElementById('view-dashboard');
    if (!root) return;
    const bars = root.querySelectorAll('.weekly-bar');
    bars.forEach((b) => {
        b.style.height = '0%';
    });
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            bars.forEach((b) => {
                const pct = parseFloat(b.getAttribute('data-height-pct'));
                if (!Number.isNaN(pct)) b.style.height = `${Math.min(100, pct)}%`;
            });
        });
    });
}

function runDashboardEnterAnimations() {
    const dash = document.getElementById('view-dashboard');
    if (!dash || !dash.classList.contains('active')) return;

    const greet = document.getElementById('dash-greeting-word');
    if (greet) greet.textContent = getGreetingWord();

    const points = parseInt(dash.getAttribute('data-user-points'), 10) || 0;
    const streak = parseInt(dash.getAttribute('data-streak-count'), 10);
    updateLevelUI(points, Number.isFinite(streak) ? streak : 0);

    const s1 = document.getElementById('stat-total-co2');
    const s2 = document.getElementById('stat-co2-saved');
    const s3 = document.getElementById('stat-receipts');
    const t1 = parseFloat(s1?.getAttribute('data-target')) || 0;
    const t2 = parseFloat(s2?.getAttribute('data-target')) || 0;
    const t3 = parseInt(s3?.getAttribute('data-target'), 10) || 0;
    animateStatCountUp(s1, t1, 1, '');
    animateStatCountUp(s2, t2, 1, '');
    animateStatCountUp(s3, t3, 0, '');

    animateHabitBarsDeferred();
    animateWeeklyBarsDeferred();
}

function renderDashboardHabits(trends, totalCo2) {
    const body = document.getElementById('dashboard-habits-body');
    if (!body) return;
    const entries = Object.entries(trends || {});
    if (!entries.length) {
        body.innerHTML =
            '<p class="text-sm text-muted">Upload receipts to track your habits.</p>';
        return;
    }
    const denom = Math.max(Number(totalCo2) || 0, 1e-6);
    body.innerHTML = entries
        .map(([cat, amount]) => {
            const amt = Number(amount) || 0;
            const pct = Math.min(100, (amt / denom) * 100);
            const esc = escapeHtml(cat);
            return `
            <div class="habit-row" data-category="${esc}">
                <div class="habit-row-header">
                    <p class="text-sm font-bold">${esc}</p>
                    <p class="text-xs habit-kg">${amt.toFixed(2)} kg CO2e</p>
                </div>
                <div class="habit-track">
                    <div class="habit-fill" data-pct="${pct}" style="width: 0%;"></div>
                </div>
            </div>`;
        })
        .join('');
}

function renderDashboardWeekly(weeklyTrend, weeklyMax) {
    const chart = document.getElementById('dashboard-weekly-chart');
    if (!chart || !weeklyTrend) return;
    const max = Math.max(
        Number(weeklyMax) || 0.01,
        ...weeklyTrend.map((w) => Number(w.total_co2) || 0),
        0.01
    );
    chart.innerHTML = weeklyTrend
        .map((w) => {
            const co2 = Number(w.total_co2) || 0;
            const h = max > 0 ? (co2 / max) * 100 : 0;
            return `
            <div class="weekly-chart-col">
                <div class="weekly-bar-wrap">
                    <div class="weekly-bar" data-height-pct="${h}" style="height: 0%;"></div>
                </div>
                <p class="weekly-bar-value">${co2.toFixed(2)} kg</p>
                <p class="weekly-bar-label">${escapeHtml(w.week_label)}</p>
            </div>`;
        })
        .join('');
}

function renderTopOffendersList(rows) {
    const el = document.getElementById('dashboard-top-offenders');
    if (!el) return;
    if (!rows || !rows.length) {
        const dash = document.getElementById('view-dashboard');
        const rc = Number(dash?.getAttribute('data-stat-receipts')) || 0;
        if (rc === 0) {
            el.innerHTML = `<div class="empty-state-card" style="padding: 1.25rem; text-align: center;">
                <p class="text-sm font-bold" style="margin-bottom: 0.5rem;">Upload your first receipt to start tracking!</p>
                <button type="button" class="btn btn-outline btn-sm js-empty-cta-upload">Upload receipt</button>
            </div>`;
        } else {
            el.innerHTML =
                '<p class="text-sm text-muted">Upload receipts to see your highest-impact purchases.</p>';
        }
        return;
    }
    el.innerHTML = `<div class="top-offenders-list">${rows
        .map((row) => {
            const slug = categorySlug(row.category);
            const brandLine = row.brand
                ? `<p class="text-xs text-muted">${escapeHtml(row.brand)}</p>`
                : '';
            const ridSafe = String(row.receipt_id || '').replace(/"/g, '');
            const swapBtn = ridSafe
                ? `<button type="button" class="link-swap js-swap-for-receipt" data-receipt-id="${ridSafe}">Find a swap</button>`
                : '';
            return `
            <div class="top-offender-row">
                <div class="top-offender-main">
                    <span class="category-dot category-dot--${slug}" title="${escapeHtml(row.category)}"></span>
                    <div>
                        <p class="text-sm font-bold">${escapeHtml(row.item_name)}</p>
                        ${brandLine}
                        <span class="category-chip category-chip--${slug}">${escapeHtml(row.category)}</span>
                    </div>
                </div>
                <div class="top-offender-meta">
                    <p class="text-sm font-bold text-high-impact">${Number(row.kg_co2e).toFixed(2)} kg</p>
                    ${swapBtn}
                </div>
            </div>`;
        })
        .join('')}</div>`;
}

function renderUserSwapsCard(swaps) {
    let wrap = document.getElementById('dashboard-user-swaps');
    let heading = document.getElementById('dashboard-swaps-heading');
    if (!swaps || !swaps.length) {
        if (wrap) wrap.remove();
        if (heading) heading.remove();
        return;
    }
    if (!wrap) {
        const anchor = document.getElementById('dashboard-offender-swap-results');
        const parent = anchor?.parentNode || document.getElementById('view-dashboard');
        if (!parent) return;
        heading = document.createElement('h3');
        heading.className = 'text-lg mb-2 mt-4';
        heading.id = 'dashboard-swaps-heading';
        heading.textContent = 'Your Swap Ideas';
        wrap = document.createElement('div');
        wrap.className = 'card dashboard-swaps-card';
        wrap.id = 'dashboard-user-swaps';
        if (anchor && anchor.nextSibling) {
            parent.insertBefore(heading, anchor.nextSibling);
            parent.insertBefore(wrap, heading.nextSibling);
        } else {
            parent.appendChild(heading);
            parent.appendChild(wrap);
        }
    } else if (!heading) {
        heading = document.createElement('h3');
        heading.className = 'text-lg mb-2 mt-4';
        heading.id = 'dashboard-swaps-heading';
        heading.textContent = 'Your Swap Ideas';
        wrap.parentNode.insertBefore(heading, wrap);
    }
    const slice = swaps.slice(0, 8);
    wrap.innerHTML = `<ul class="dashboard-swaps-list">${slice
        .map((sw) => {
            const sid = sw.id != null ? String(sw.id) : '';
            const accepted = Boolean(sw.accepted);
            const btnClass = `btn btn-outline btn-sm js-accept-swap${accepted ? ' is-accepted' : ''}`;
            const btnDis = accepted ? ' disabled aria-label="Accepted"' : '';
            const btnInner = accepted
                ? '<i data-lucide="check" class="swap-accept-icon"></i> Accepted'
                : 'Accept Swap';
            const liCls = accepted ? 'dashboard-swap-li dashboard-swap-li--accepted' : 'dashboard-swap-li';
            return `
        <li class="${liCls}">
            <div class="dashboard-swap-li-main">
                <span class="text-sm"><strong>${escapeHtml(sw.original_product)}</strong> → ${
                    sw.recommended_brand ? `${escapeHtml(sw.recommended_brand)} ` : ''
                }${escapeHtml(sw.recommended_product)}</span>
                <span class="text-xs" style="color: var(--green-impact); font-weight: 600;">Save ~${Number(
                    sw.co2_savings
                ).toFixed(2)} kg</span>
            </div>
            <button type="button" class="${btnClass}" data-swap-id="${escapeHtml(sid)}"${btnDis}>${btnInner}</button>
        </li>`;
        })
        .join('')}</ul>`;
    if (window.lucide) window.lucide.createIcons();
}

function renderRecentActivitiesDash(list) {
    const listContainer = document.getElementById('dashboard-recent-activities');
    if (!listContainer) return;
    if (!list || !list.length) {
        const dash = document.getElementById('view-dashboard');
        const rc = Number(dash?.getAttribute('data-stat-receipts')) || 0;
        if (rc === 0) {
            listContainer.innerHTML = `<div class="empty-state-card" style="padding: 1.75rem; text-align: center;">
                <p class="text-sm font-bold" style="margin-bottom: 0.5rem;">Upload your first receipt to start tracking!</p>
                <p class="text-xs text-muted mb-3">We will estimate carbon per item and build your habits chart.</p>
                <button type="button" class="btn btn-primary btn-sm js-empty-cta-upload">Upload receipt</button>
            </div>`;
        } else {
            listContainer.innerHTML =
                '<p class="text-sm text-muted" style="padding: 1.5rem;">No activities logged yet.</p>';
        }
        return;
    }
    listContainer.innerHTML = list
        .map((a) => {
            const slug = categorySlug(a.category);
            let colorClass = '';
            if (a.kg_co2e > 5) colorClass = 'text-high-impact';
            else if (a.kg_co2e < 1.5) colorClass = 'text-low-impact';
            const brandDisplay = a.brand
                ? ` <span style="color:#6b7280; font-size:0.85em;">(${escapeHtml(a.brand)})</span>`
                : '';
            return `
            <div class="dash-recent-row" style="display: flex; align-items: center; justify-content: space-between; padding: 1rem; border-bottom: 1px solid var(--border);">
                <div style="display: flex; gap: 0.75rem; align-items: center; min-width: 0;">
                    <span class="category-dot category-dot--${slug}" title="${escapeHtml(a.category)}"></span>
                    <div style="background: #f1f5f9; padding: 0.5rem; border-radius: 8px; flex-shrink: 0;">
                        <i data-lucide="shopping-bag" size="18"></i>
                    </div>
                    <div style="min-width: 0;">
                        <p class="text-sm font-bold" style="overflow-wrap: break-word;">${escapeHtml(
                            a.item_name
                        )}${brandDisplay}</p>
                        <p class="text-xs text-muted">${escapeHtml(a.category || 'General')}</p>
                    </div>
                </div>
                <p class="text-sm font-bold flex-shrink-0 ${colorClass}">${Number(a.kg_co2e).toFixed(2)}kg</p>
            </div>`;
        })
        .join('');
    if (window.lucide) window.lucide.createIcons();
}

function applyDashboardStatsPayload(data) {
    if (!data) return;
    const dash = document.getElementById('view-dashboard');
    if (dash) {
        dash.setAttribute('data-stat-co2', data.total_co2);
        dash.setAttribute('data-stat-saved', data.total_co2_saved);
        dash.setAttribute('data-stat-receipts', data.receipts_count);
        dash.setAttribute('data-user-points', data.points);
        dash.setAttribute('data-streak-count', data.streak_count ?? 0);
    }
    const s1 = document.getElementById('stat-total-co2');
    const s2 = document.getElementById('stat-co2-saved');
    const s3 = document.getElementById('stat-receipts');
    if (s1) s1.setAttribute('data-target', data.total_co2 ?? 0);
    if (s2) s2.setAttribute('data-target', data.total_co2_saved ?? 0);
    if (s3) s3.setAttribute('data-target', data.receipts_count ?? 0);

    const iw = document.getElementById('dash-items-week');
    if (iw) iw.textContent = data.items_this_week;

    if (data.name) {
        const sn = document.getElementById('sidebar-display-name');
        if (sn) sn.textContent = data.name;
        const fn = document.getElementById('dash-user-firstname');
        if (fn) {
            const parts = String(data.name).trim().split(/\s+/);
            fn.textContent = parts[0] || 'Jason';
        }
    }

    updateLevelUI(data.points, data.streak_count);

    renderDashboardHabits(data.trends, data.total_co2);
    renderDashboardWeekly(data.weekly_trend, data.weekly_chart_max);
    renderTopOffendersList(data.top_offenders);
    renderUserSwapsCard(data.user_swaps);
    renderRecentActivitiesDash(data.recent_activities);
}

async function fetchSwapsForDashboard(receiptId) {
    const panel = document.getElementById('dashboard-offender-swap-results');
    if (!panel || !receiptId) return;
    panel.style.display = 'block';
    panel.innerHTML =
        '<p class="text-xs text-muted">Loading swap ideas for this receipt…</p>';
    try {
        const response = await fetch('/api/generate-swaps', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ receipt_id: receiptId }),
        });
        const payload = await response.json();
        if (!response.ok) {
            showToast(payload.error || 'Could not load swaps', 'error');
            panel.innerHTML = `<p class="text-sm" style="color: var(--accent);">${escapeHtml(
                payload.error || 'Could not load swaps'
            )}</p>`;
            return;
        }
        const swaps = payload.swaps || [];
        if (!swaps.length) {
            panel.innerHTML =
                '<p class="text-sm text-muted">No swap suggestions matched this receipt.</p>';
            return;
        }
        showToast('Swap recommendation ready!', 'success');
        let cards = '';
        swaps.forEach((sw) => {
            const brand = sw.recommended_brand
                ? `${escapeHtml(sw.recommended_brand)} `
                : '';
            const aisleRow = sw.aisle_location
                ? `<p class="text-xs text-muted mt-2" style="opacity: 0.75;">${escapeHtml(
                      sw.aisle_location
                  )}</p>`
                : '';
            const sid = sw.swap_id != null ? String(sw.swap_id) : '';
            cards += `
                <div class="card swap-rec-card" style="margin-top: 0.75rem; padding: 1rem; border-left: 3px solid var(--green-impact);">
                    <p class="text-sm font-bold" style="margin-bottom: 0.35rem;">
                        Swap <span class="text-muted font-normal">${escapeHtml(
                            sw.original_product
                        )}</span>
                        → <span>${brand}${escapeHtml(sw.recommended_product)}</span>
                    </p>
                    <p class="text-sm" style="color: var(--green-impact); font-weight: 700; margin-bottom: 0.35rem;">
                        Save ~${Number(sw.co2_savings).toFixed(2)} kg CO2e
                    </p>
                    <p class="text-xs text-muted" style="line-height: 1.45;">${escapeHtml(sw.reason)}</p>
                    ${aisleRow}
                    <button type="button" class="btn btn-primary btn-sm mt-3 js-accept-swap" data-swap-id="${escapeHtml(
                        sid
                    )}">Accept Swap</button>
                </div>`;
        });
        panel.innerHTML = `<div class="dashboard-offender-swaps-inner">${cards}</div>`;
    } catch (e) {
        console.error(e);
        showToast('Network error loading swaps.', 'error');
        panel.innerHTML =
            '<p class="text-sm" style="color: var(--accent);">Network error loading swaps.</p>';
    }
}

async function loadSwapRecommendations(receiptId) {
    const container = document.getElementById('swap-recommendations-container');
    const btn = document.getElementById('btn-get-swaps');
    if (!container || !receiptId) return;
    container.innerHTML =
        '<p class="text-xs text-muted" style="display:flex;align-items:center;gap:8px;"><span class="spinner sm" aria-hidden="true"></span> Loading recommendations…</p>';
    if (btn) {
        btn.disabled = true;
    }
    try {
        const response = await fetch('/api/generate-swaps', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ receipt_id: receiptId })
        });
        const payload = await response.json();
        if (!response.ok) {
            showToast(payload.error || 'Could not load swaps', 'error');
            container.innerHTML = `<p class="text-xs" style="color: var(--accent);">${escapeHtml(payload.error || 'Could not load swaps')}</p>`;
            return;
        }
        const swaps = payload.swaps || [];
        if (swaps.length === 0) {
            container.innerHTML = '<p class="text-xs text-muted">No swap suggestions could be matched to your line items.</p>';
            return;
        }
        showToast('Swap recommendation ready!', 'success');
        let cards = '';
        swaps.forEach((sw) => {
            const brand = sw.recommended_brand
                ? `${escapeHtml(sw.recommended_brand)} `
                : '';
            const aisleRow = sw.aisle_location
                ? `<p class="text-xs text-muted mt-2" style="opacity: 0.75;">${escapeHtml(sw.aisle_location)}</p>`
                : '';
            const sid = sw.swap_id != null ? String(sw.swap_id) : '';
            cards += `
                <div class="card swap-rec-card" style="margin-top: 0.75rem; padding: 1rem; border-left: 3px solid var(--green-impact);">
                    <p class="text-sm font-bold" style="margin-bottom: 0.35rem;">
                        Swap <span class="text-muted font-normal">${escapeHtml(sw.original_product)}</span>
                        → <span>${brand}${escapeHtml(sw.recommended_product)}</span>
                    </p>
                    <p class="text-sm" style="color: var(--green-impact); font-weight: 700; margin-bottom: 0.35rem;">
                        Save ~${Number(sw.co2_savings).toFixed(2)} kg CO2e
                    </p>
                    <p class="text-xs text-muted" style="line-height: 1.45;">${escapeHtml(sw.reason)}</p>
                    ${aisleRow}
                    <button type="button" class="btn btn-primary btn-sm mt-3 js-accept-swap" data-swap-id="${escapeHtml(
                        sid
                    )}">Accept Swap</button>
                </div>
            `;
        });
        container.innerHTML = cards;
    } catch (e) {
        console.error(e);
        showToast('Network error loading swaps.', 'error');
        container.innerHTML = '<p class="text-xs" style="color: var(--accent);">Network error loading swaps.</p>';
    } finally {
        if (btn) btn.disabled = false;
    }
}

// Dynamic AI Rendering — result: { filename, store_name, receipt_id, data }
function displayAIResults(result) {
    const feedback = document.getElementById('ai-feedback');
    if (!feedback) return;
    feedback.style.display = 'block';
    const filename = result.filename || '';
    const storeName = result.store_name;
    const receiptId = result.receipt_id;
    const data = result.data || [];

    let itemsHtml = '';
    if (data.length > 0) {
        data.forEach((item) => {
            const icon = categoryIcon(item.category);
            let fpColor = 'var(--text-muted)';
            const kg = Number(item.kg_co2e);
            if (kg > 5) fpColor = 'var(--accent)';
            else if (kg < 1.5) fpColor = 'var(--green-impact)';
            const brandHtml = item.brand
                ? ` <span class="text-xs" style="opacity: 0.85;">(${escapeHtml(item.brand)})</span>`
                : '';
            itemsHtml += `
                <li>${icon} <span class="font-bold">${escapeHtml(item.item_name)}</span>${brandHtml}
                → <span style="color: ${fpColor}; font-weight: 700;">${kg.toFixed(2)} kg CO2e</span></li>
            `;
        });
    } else {
        itemsHtml = '<li>No items cleanly extracted.</li>';
    }

    const storeLine = storeName
        ? `<p class="text-xs text-muted mb-1">Store: <span class="font-bold">${escapeHtml(storeName)}</span></p>`
        : '';

    const swapBlock =
        receiptId
            ? `
        <button type="button" class="btn btn-outline btn-sm mt-3" id="btn-get-swaps">Get Swap Recommendations</button>
        <div id="swap-recommendations-container" class="mt-2"></div>
    `
            : '';

    feedback.innerHTML = `
        <div class="card" style="border-left: 4px solid var(--primary-dark); animation: slideIn 0.3s ease-out;">
            <div style="display: flex; gap: 1rem;">
                <div class="ai-icon">
                    <i data-lucide="check-circle"></i>
                </div>
                <div style="flex: 1; min-width: 0;">
                    <p class="text-sm font-bold">Receipt Parsed Successfully</p>
                    ${storeLine}
                    <p class="text-xs text-muted mb-2">Source: ${escapeHtml(filename)}</p>
                    <p class="text-sm mt-1">Here is the carbon footprint breakdown of your items:</p>
                    <ul style="font-size: 0.875rem; color: var(--text-muted); margin-top: 0.8rem; list-style: none; display: flex; flex-direction: column; gap: 0.5rem;">
                        ${itemsHtml}
                    </ul>
                    ${swapBlock}
                    <div class="mt-4">
                        <button class="btn btn-primary btn-sm" onclick="refreshAllData(); switchView('dashboard');">Close & Refresh</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    if (receiptId) {
        const btn = document.getElementById('btn-get-swaps');
        if (btn) {
            btn.addEventListener('click', () => loadSwapRecommendations(receiptId));
        }
    }

    if (result.points_awarded) {
        showPointsFloater(result.points_awarded);
    }
    void refreshHistoryView();
    void refreshDashboardData().then(() => loadBadges());

    if (window.lucide) {
        window.lucide.createIcons();
    }
}

// Dynamic Dashboard Refresh
async function refreshDashboardData() {
    const showSkel = window.__dashboardStatsFetchedOnce === true;
    window.__dashboardStatsFetchedOnce = true;
    if (showSkel) setDashboardLoading(true);
    try {
        const response = await fetch('/api/stats');
        let data;
        try {
            data = await response.json();
        } catch (parseErr) {
            throw new Error('Invalid response from server');
        }
        if (!response.ok) throw new Error(data.error || 'Could not load dashboard stats');
        applyDashboardStatsPayload(data);
        runDashboardEnterAnimations();
    } catch (err) {
        console.error('Dashboard refresh error:', err);
        showToast(err.message || 'Dashboard refresh failed', 'error');
    } finally {
        if (showSkel) setDashboardLoading(false);
    }
}

const HISTORY_MANUAL_KEY = '__manual__';

const historyState = {
    receipts: [],
    page: 0,
    totalPages: 0,
    totalReceipts: 0,
    perPage: 20,
    loading: false,
    loadMorePending: false,
    dirty: true,
    toolbarBound: false,
};

function historyCo2Band(total) {
    const t = Number(total) || 0;
    if (t > 15) return 'high';
    if (t >= 5) return 'medium';
    return 'low';
}

function historyCo2TotalClass(total) {
    const t = Number(total) || 0;
    if (t > 15) return 'text-high-impact';
    if (t >= 5) return 'history-co2-mid';
    return 'text-low-impact';
}

function historyItemCo2Class(kg) {
    const x = Number(kg) || 0;
    if (x > 5) return 'text-high-impact';
    if (x < 1.5) return 'text-low-impact';
    return '';
}

function historyCategoryBarHtml(items) {
    if (!items || !items.length) return '';
    const counts = {};
    items.forEach((i) => {
        const c = i.category || 'Other';
        counts[c] = (counts[c] || 0) + 1;
    });
    const entries = Object.entries(counts);
    const segs = entries
        .map(([cat, n]) => {
            const slug = categorySlug(cat);
            return `<span class="history-cat-seg history-cat-seg--${slug}" style="flex-grow:${n}" title="${escapeHtml(
                cat
            )}"></span>`;
        })
        .join('');
    return `<div class="history-cat-bar" aria-hidden="true">${segs}</div>`;
}

function filterHistoryReceipts(list) {
    const q = (document.getElementById('history-search')?.value || '').trim().toLowerCase();
    const cat = document.getElementById('history-filter-category')?.value || '';
    let rows = list.slice();
    if (q) {
        rows = rows.filter((r) => {
            const label = String(r.receipt_label || r.receipt_id || '').toLowerCase();
            const key = String(r.receipt_key || '').toLowerCase();
            if (label.includes(q) || key.includes(q)) return true;
            return (r.items || []).some((it) => {
                const n = String(it.item_name || it.name || '').toLowerCase();
                const b = String(it.brand || '').toLowerCase();
                return n.includes(q) || b.includes(q);
            });
        });
    }
    if (cat) {
        rows = rows.filter((r) => (r.items || []).some((it) => (it.category || '') === cat));
    }
    return rows;
}

function renderHistoryReceiptCardsHtml(receipts) {
    if (!receipts.length) {
        return `<div class="card history-empty-card">
            <i data-lucide="archive" size="48" class="text-muted" style="margin-bottom: 1rem;"></i>
            <h3 class="text-xl">No receipts match</h3>
            <p class="text-muted mt-2">Try another search, or load more history.</p>
        </div>`;
    }
    return receipts
        .map((receipt) => {
            const key = escapeAttr(receipt.receipt_key ?? '');
            const label = escapeHtml(receipt.receipt_label || receipt.receipt_id || 'Receipt');
            const band = historyCo2Band(receipt.total_co2);
            const totalClass = historyCo2TotalClass(receipt.total_co2);
            const apiId =
                receipt.receipt_id != null ? escapeAttr(String(receipt.receipt_id)) : '';
            const hasApiReceipt = receipt.receipt_key !== HISTORY_MANUAL_KEY;
            const catBar = historyCategoryBarHtml(receipt.items || []);
            return `
            <div class="card history-receipt-card history-card--co2-${band}" role="listitem"
                data-receipt-key="${key}"
                data-receipt-label="${escapeAttr(receipt.receipt_label || '')}"
                data-receipt-api-id="${apiId}"
                data-has-receipt-id="${hasApiReceipt ? '1' : '0'}">
                <button type="button" class="history-card-header" aria-expanded="false">
                    <div class="history-card-header-main">
                        <p class="history-card-kicker">Receipt</p>
                        <h3 class="history-card-title">${label}</h3>
                        ${catBar}
                    </div>
                    <div class="history-card-header-meta">
                        <p class="history-card-meta-label">Logged</p>
                        <p class="history-card-meta-value">${escapeHtml(receipt.date)}</p>
                        <p class="history-card-meta-label" style="margin-top:0.5rem">Total CO₂e</p>
                        <p class="history-card-meta-co2 ${totalClass}">${Number(receipt.total_co2).toFixed(2)} kg</p>
                        <p class="history-card-item-count">${Number(receipt.item_count || 0)} items</p>
                    </div>
                    <span class="history-card-chevron" aria-hidden="true"><i data-lucide="chevron-down"></i></span>
                </button>
                <div class="history-card-expand">
                    <div class="history-card-expand-inner" data-detail-loaded="0"></div>
                </div>
            </div>`;
        })
        .join('');
}

function updateHistoryLoadMoreButton() {
    const btn = document.getElementById('history-load-more');
    if (!btn) return;
    const more = historyState.page < historyState.totalPages;
    btn.hidden = !more || historyState.totalReceipts === 0;
}

function applyHistoryFiltersAndRender() {
    const listEl = document.getElementById('history-cards-list');
    if (!listEl) return;
    const filtered = filterHistoryReceipts(historyState.receipts);
    if (!historyState.receipts.length && !historyState.loading) {
        listEl.innerHTML = `<div class="card history-empty-card">
            <i data-lucide="archive" size="48" class="text-muted" style="margin-bottom: 1rem;"></i>
            <h3 class="text-xl">No History Yet</h3>
            <p class="text-muted mt-2 mb-3">Upload your first receipt to start tracking!</p>
            <button type="button" class="btn btn-primary btn-sm js-empty-cta-upload">Upload receipt</button>
        </div>`;
    } else {
        listEl.innerHTML = renderHistoryReceiptCardsHtml(filtered);
    }
    updateHistoryLoadMoreButton();
    if (window.lucide) window.lucide.createIcons();
}

function bindHistoryToolbarOnce() {
    if (historyState.toolbarBound) return;
    historyState.toolbarBound = true;
    const search = document.getElementById('history-search');
    const cat = document.getElementById('history-filter-category');
    if (search) {
        search.addEventListener('input', () => applyHistoryFiltersAndRender());
    }
    if (cat) {
        cat.addEventListener('change', () => applyHistoryFiltersAndRender());
    }
    const more = document.getElementById('history-load-more');
    if (more) {
        more.addEventListener('click', () => loadHistoryPage(historyState.page + 1, false));
    }
}

function renderHistorySkeletonList() {
    const cards = [1, 2, 3]
        .map(
            () =>
                `<div class="history-skeleton-card card"><div class="skeleton-line skeleton-line--md mb-2" style="width:45%"></div><div class="skeleton-line skeleton-line--full"></div></div>`
        )
        .join('');
    return `<div class="history-skeleton-list">${cards}</div>`;
}

async function loadHistoryPage(page, replace) {
    const hint = document.getElementById('history-loading-hint');
    const listEl = document.getElementById('history-cards-list');
    if (!listEl) return;
    if (replace) {
        historyState.loading = true;
        listEl.innerHTML = renderHistorySkeletonList();
        if (hint) hint.hidden = false;
    } else {
        historyState.loadMorePending = true;
        const btn = document.getElementById('history-load-more');
        if (btn) btn.disabled = true;
    }
    try {
        const res = await fetch(
            `/api/history?page=${page}&per_page=${historyState.perPage}`
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load history');
        if (replace) {
            historyState.receipts = data.history || [];
        } else {
            historyState.receipts = historyState.receipts.concat(data.history || []);
        }
        historyState.page = data.page || page;
        historyState.totalPages = data.total_pages ?? 0;
        historyState.totalReceipts = data.total_receipts ?? historyState.receipts.length;
        historyState.dirty = false;
        applyHistoryFiltersAndRender();
    } catch (e) {
        console.error(e);
        if (replace && listEl) {
            listEl.innerHTML = `<p class="text-sm" style="color:var(--accent)">${escapeHtml(
                e.message || 'Could not load history'
            )}</p>`;
        }
    } finally {
        historyState.loading = false;
        historyState.loadMorePending = false;
        if (hint) hint.hidden = true;
        const btn = document.getElementById('history-load-more');
        if (btn) btn.disabled = false;
        updateHistoryLoadMoreButton();
    }
}

async function initHistoryViewIfNeeded() {
    bindHistoryToolbarOnce();
    if (historyState.dirty || !historyState.receipts.length) {
        await loadHistoryPage(1, true);
    } else {
        applyHistoryFiltersAndRender();
    }
}

async function refreshHistoryView() {
    historyState.dirty = true;
    historyState.receipts = [];
    historyState.page = 0;
    const hist = document.getElementById('view-history');
    if (hist && hist.classList.contains('active')) {
        await loadHistoryPage(1, true);
    }
}

function renderHistorySwapCards(swaps) {
    if (!swaps || !swaps.length) return '';
    return swaps
        .map((sw) => {
            const brand = sw.recommended_brand
                ? `${escapeHtml(sw.recommended_brand)} `
                : '';
            const aisleRow = sw.aisle_location
                ? `<p class="text-xs text-muted mt-2" style="opacity: 0.75;">${escapeHtml(
                      sw.aisle_location
                  )}</p>`
                : '';
            const sid = sw.swap_id != null ? String(sw.swap_id) : '';
            const accepted = sw.accepted ? ' is-accepted' : '';
            const disabled = sw.accepted ? ' disabled' : '';
            const btnLabel = sw.accepted ? 'Accepted' : 'Accept Swap';
            return `
                <div class="card swap-rec-card history-detail-swap-card${sw.accepted ? ' swap-rec-card--accepted' : ''}" style="margin-top: 0.75rem; padding: 1rem; border-left: 3px solid var(--green-impact);">
                    <p class="text-sm font-bold" style="margin-bottom: 0.35rem;">
                        Swap <span class="text-muted font-normal">${escapeHtml(sw.original_product)}</span>
                        → <span>${brand}${escapeHtml(sw.recommended_product)}</span>
                    </p>
                    <p class="text-sm" style="color: var(--green-impact); font-weight: 700; margin-bottom: 0.35rem;">
                        Save ~${Number(sw.co2_savings).toFixed(2)} kg CO2e
                    </p>
                    <p class="text-xs text-muted" style="line-height: 1.45;">${escapeHtml(sw.reason)}</p>
                    ${aisleRow}
                    <button type="button" class="btn btn-primary btn-sm mt-3 js-accept-swap${accepted}" data-swap-id="${escapeAttr(
                sid
            )}"${disabled}>${btnLabel}</button>
                </div>`;
        })
        .join('');
}

function renderHistoryDetailHtml(data, card) {
    const rows = (data.items || [])
        .map((it) => {
            const slug = categorySlug(it.category);
            const co2c = historyItemCo2Class(it.kg_co2e);
            const brandDisplay = it.brand
                ? ` <span style="color:#6b7280; font-size:0.85em;">(${escapeHtml(it.brand)})</span>`
                : '';
            return `<tr class="history-detail-row">
                <td style="padding:6px 8px;"><span class="text-sm font-bold">${escapeHtml(
                    it.item_name
                )}</span>${brandDisplay}</td>
                <td><span class="category-chip category-chip--${slug}">${escapeHtml(it.category)}</span></td>
                <td class="history-detail-qty">${Number(it.quantity).toFixed(
                    Number(it.quantity) % 1 ? 2 : 0
                )} ${escapeHtml(it.unit || '')}</td>
                <td class="history-detail-co2 text-sm font-bold ${co2c}">${Number(it.kg_co2e).toFixed(
                2
            )} kg</td>
            </tr>`;
        })
        .join('');

    const mobileCards = (data.items || [])
        .map((it) => {
            const slug = categorySlug(it.category);
            const co2c = historyItemCo2Class(it.kg_co2e);
            const brandDisplay = it.brand
                ? ` <span style="color:#6b7280; font-size:0.85em;">(${escapeHtml(it.brand)})</span>`
                : '';
            const qty = Number(it.quantity).toFixed(Number(it.quantity) % 1 ? 2 : 0);
            return `<div class="history-item-card">
                <div class="history-item-card-top">
                    <span class="text-sm font-bold" style="flex:1;min-width:0">${escapeHtml(
                        it.item_name
                    )}${brandDisplay}</span>
                    <span class="text-sm font-bold ${co2c}">${Number(it.kg_co2e).toFixed(2)} kg</span>
                </div>
                <p class="history-item-card-meta"><span class="category-chip category-chip--${slug}">${escapeHtml(
                it.category
            )}</span> · Qty ${qty} ${escapeHtml(it.unit || '')}</p>
            </div>`;
        })
        .join('');

    const swapsHtml = renderHistorySwapCards(data.swaps);
    const hasReceipt = card.getAttribute('data-has-receipt-id') === '1';
    const rid = card.getAttribute('data-receipt-api-id') || '';
    const genBtn = hasReceipt
        ? `<button type="button" class="btn btn-secondary btn-sm js-history-generate-swaps" data-receipt-id="${escapeAttr(
              rid
          )}">Get AI Swaps</button>`
        : '';

    const rkForAsk = card.getAttribute('data-receipt-key') || data.receipt_key || '';

    const swapsBlock =
        swapsHtml ||
        `<p class="text-xs text-muted history-detail-no-swaps">Looking good! Check back after your next receipt for swap ideas.</p>`;

    const high = data.highest_co2_item;
    const highLine = high
        ? `<p class="text-xs text-muted history-highest-co2">Highest-impact line: <strong>${escapeHtml(
              high.item_name
          )}</strong> (${Number(high.kg_co2e).toFixed(2)} kg CO₂e)</p>`
        : '';

    return `
        <div class="history-detail-inner">
            ${highLine}
            <div class="history-detail-cards-mobile">${mobileCards}</div>
            <div class="history-detail-table-wrap history-detail-table-desktop">
                <table class="history-detail-table">
                    <thead>
                        <tr>
                            <th>Item</th>
                            <th>Category</th>
                            <th>Qty</th>
                            <th>CO₂e</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            <div class="history-detail-actions">
                <button type="button" onclick="window.askAIAboutReceipt && window.askAIAboutReceipt(${JSON.stringify(
        rkForAsk
    )})" style="padding:8px 16px; background:white; color:#4f772d; border:1px solid #4f772d; border-radius:8px; cursor:pointer; font-family:'Outfit',sans-serif; font-weight:600; font-size:0.85em; display:inline-flex; align-items:center; gap:6px;">
                    <i data-lucide="message-circle" style="width:14px;height:14px;"></i> Ask AI about this receipt
                </button>
                ${genBtn}
            </div>
            <div class="history-detail-swaps">
                <p class="text-xs font-bold uppercase tracking-wider text-muted mb-2">Swaps</p>
                ${swapsBlock}
            </div>
        </div>`;
}

async function loadHistoryReceiptDetail(card, receiptKey) {
    const inner = card.querySelector('.history-card-expand-inner');
    if (!inner) return;
    inner.innerHTML = '<p class="text-sm text-muted history-detail-loading">Loading details…</p>';
    inner.setAttribute('data-detail-loaded', '0');
    try {
        const res = await fetch('/api/history/' + encodeURIComponent(receiptKey));
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load receipt');
        inner.innerHTML = renderHistoryDetailHtml(data, card);
        inner.setAttribute('data-detail-loaded', '1');
        if (window.lucide) window.lucide.createIcons();
    } catch (e) {
        console.error(e);
        inner.innerHTML = `<p class="text-sm" style="color:var(--accent)">${escapeHtml(
            e.message || 'Error'
        )}</p>`;
    }
}

async function toggleHistoryReceiptCard(card) {
    const inner = card.querySelector('.history-card-expand-inner');
    const header = card.querySelector('.history-card-header');
    const key = card.getAttribute('data-receipt-key');
    if (!inner || !key) return;
    const open = card.classList.contains('is-expanded');
    if (open) {
        card.classList.remove('is-expanded');
        if (header) header.setAttribute('aria-expanded', 'false');
        return;
    }
    card.classList.add('is-expanded');
    if (header) header.setAttribute('aria-expanded', 'true');
    if (inner.getAttribute('data-detail-loaded') === '1') return;
    await loadHistoryReceiptDetail(card, key);
}

async function runHistoryGenerateSwaps(btn) {
    const rid = btn.getAttribute('data-receipt-id');
    if (!rid) return;
    const card = btn.closest('.history-receipt-card');
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = 'Generating…';
    try {
        const res = await fetch('/api/generate-swaps', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ receipt_id: rid }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not generate swaps');
        const nSwaps = (data.swaps || []).length;
        if (card) {
            const key = card.getAttribute('data-receipt-key');
            if (key) await loadHistoryReceiptDetail(card, key);
            card.classList.add('is-expanded');
        }
        if (nSwaps > 0) showToast('Swap recommendation ready!', 'success');
    } catch (e) {
        showToast(e.message || 'Could not generate swaps', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = prev;
    }
}

function runLeaderboardCountUps(root) {
    if (!root) return;
    root.querySelectorAll('[data-lb-target]').forEach((el) => {
        const tgt = parseFloat(el.getAttribute('data-lb-target'));
        const dec = parseInt(el.getAttribute('data-lb-decimals') || '0', 10);
        const suf = el.getAttribute('data-lb-suffix') || '';
        animateStatCountUp(el, tgt, dec, suf);
    });
}

function leaderboardRankPillClass(rank) {
    const r = Number(rank) || 0;
    if (r <= 5) return 'rank-pill rank-pill--top';
    if (r <= 10) return 'rank-pill rank-pill--mid';
    return 'rank-pill rank-pill--rest';
}

function renderPodiumCard(entry, podiumClass, medalEmoji, delayMs) {
    if (!entry) {
        return `<div class="podium-card podium-card--empty ${podiumClass} podium-animate" style="animation-delay:${delayMs}ms" aria-hidden="true"></div>`;
    }
    const streak =
        Number(entry.streak_count) > 0
            ? `<span class="podium-streak">🔥 ${entry.streak_count} day streak</span>`
            : '<span class="podium-streak podium-streak--muted">No streak yet</span>';
    const crown = podiumClass === 'podium-1' ? '<div class="podium-crown" aria-hidden="true">👑</div>' : '';
    return `
        <div class="podium-card ${podiumClass} podium-animate" style="animation-delay:${delayMs}ms">
            ${crown}
            <div class="podium-medal" aria-hidden="true">${medalEmoji}</div>
            <div class="podium-rank-label">#${entry.rank}</div>
            <h4 class="podium-name">${escapeHtml(entry.name)}</h4>
            <p class="podium-level">${escapeHtml(entry.level)} ${escapeHtml(entry.level_emoji || '')}</p>
            <p class="podium-metric"><span class="lb-num" data-lb-target="${Number(entry.points)}" data-lb-decimals="0">0</span> pts</p>
            <p class="podium-metric podium-metric--co2"><span class="lb-num" data-lb-target="${Number(entry.total_co2_saved)}" data-lb-decimals="1" data-lb-suffix=" kg">0</span><span class="podium-co2-label"> CO₂ saved</span></p>
            ${streak}
            <p class="podium-badges"><span aria-hidden="true">⭐</span> ${Number(entry.badges_earned)} badges</p>
        </div>`;
}

function applyLeaderboardPayload(data) {
    const tbody = document.getElementById('leaderboard-tbody-g');
    const podium = document.getElementById('leaderboard-podium');
    const yourCard = document.getElementById('leaderboard-your-card');
    const moversEl = document.getElementById('leaderboard-movers');
    const footerEl = document.getElementById('leaderboard-community-footer');
    if (!tbody || !podium) return;

    const lb = data.leaderboard || [];
    if (!lb.length && !data.current_user) {
        tbody.innerHTML =
            '<tr><td colspan="7" class="text-sm text-muted" style="padding:1.25rem">Keep scanning to climb the ranks!</td></tr>';
        podium.innerHTML = '';
        if (yourCard) yourCard.hidden = true;
        if (moversEl) moversEl.innerHTML = '';
        if (footerEl) footerEl.innerHTML = '';
        if (window.lucide) window.lucide.createIcons();
        return;
    }

    const byRank = (r) => lb.find((e) => e.rank === r);
    const second = byRank(2);
    const first = byRank(1);
    const third = byRank(3);
    podium.innerHTML = `
        <div class="podium-row">
            ${renderPodiumCard(second, 'podium-2', '🥈', 0)}
            ${renderPodiumCard(first, 'podium-1', '🥇', 120)}
            ${renderPodiumCard(third, 'podium-3', '🥉', 240)}
        </div>`;

    const rows = lb.filter((e) => e.rank >= 4);
    tbody.innerHTML = rows
        .map((e, idx) => {
            const you = e.is_current_user ? ' leaderboard-row--you' : '';
            const streakCell =
                Number(e.streak_count) > 0
                    ? `🔥 ${e.streak_count}`
                    : '<span class="text-muted">—</span>';
            const lvl = `${escapeHtml(e.level)} ${escapeHtml(e.level_emoji || '')}`;
            return `<tr class="leaderboard-row-g lb-row-stagger${you}" style="--i:${idx}">
                <td><span class="${leaderboardRankPillClass(e.rank)}">${e.rank}</span></td>
                <td class="lb-name">${escapeHtml(e.name)}</td>
                <td>${lvl}</td>
                <td><span class="lb-num" data-lb-target="${Number(e.points)}" data-lb-decimals="0">0</span></td>
                <td><span class="lb-num" data-lb-target="${Number(e.total_co2_saved)}" data-lb-decimals="1" data-lb-suffix=" kg">0</span></td>
                <td>${streakCell}</td>
                <td><span aria-hidden="true">⭐</span> ${e.badges_earned}</td>
            </tr>`;
        })
        .join('');

    const cu = data.current_user;
    if (yourCard && cu) {
        if (cu.rank > 3) {
            yourCard.hidden = false;
            const nextName = cu.next_rank_name
                ? escapeHtml(cu.next_rank_name)
                : 'the next rank';
            const ptsGap = Number(cu.points_to_next_rank) || 0;
            const pct = Math.min(100, Math.max(0, Number(cu.progress_to_next_pct) || 0));
            yourCard.innerHTML = `
                <div class="leaderboard-your-card-inner">
                    <p class="leaderboard-your-title">You're ranked <strong>#${cu.rank}</strong> — ${escapeHtml(cu.percentile)}! 🎯</p>
                    <p class="leaderboard-your-sub">${ptsGap} more points to overtake <strong>${nextName}</strong></p>
                    <div class="leaderboard-your-progress-track" aria-hidden="true">
                        <div class="leaderboard-your-progress-fill" style="width:${pct}%"></div>
                    </div>
                    <p class="leaderboard-your-hint text-xs text-muted">Keep scanning receipts to climb! 📸</p>
                </div>`;
        } else {
            yourCard.hidden = true;
            yourCard.innerHTML = '';
        }
    }

    if (moversEl) {
        const movers = data.weekly_movers || [];
        if (movers.length) {
            const rowsM = movers
                .map((m) => {
                    const up = m.direction === 'up';
                    const icon = up ? 'trending-up' : 'trending-down';
                    const cls = up ? 'mover-up' : 'mover-down';
                    const arrow = up ? '↑' : '↓';
                    return `<div class="leaderboard-mover-row ${cls}">
                        <i data-lucide="${icon}"></i>
                        <div>
                            <p class="mover-name">${escapeHtml(m.name)}</p>
                            <p class="mover-delta">${arrow} ${m.positions} spot${m.positions === 1 ? '' : 's'}</p>
                        </div>
                    </div>`;
                })
                .join('');
            moversEl.innerHTML = `<h4 class="movers-heading">Biggest movers this week</h4>${rowsM}`;
        } else {
            moversEl.innerHTML = '';
        }
    }

    if (footerEl && data.community_stats) {
        const s = data.community_stats;
        footerEl.innerHTML = `
            <div class="leaderboard-footer-stats">
                <p>🌍 Community impact: <strong>${Number(s.total_co2_saved_all).toFixed(1)} kg</strong> CO₂ saved together</p>
                <p>📸 <strong>${s.receipts_scanned_week}</strong> receipts scanned this week</p>
                <p>🔥 Longest active streak: <strong>${s.longest_streak_days}</strong> days by ${escapeHtml(s.longest_streak_name)}</p>
            </div>`;
    }

    const root = document.getElementById('leaderboard-content');
    requestAnimationFrame(() => runLeaderboardCountUps(root));
    if (window.lucide) window.lucide.createIcons();
}

async function loadLeaderboard() {
    const loading = document.getElementById('leaderboard-loading');
    const sk = document.getElementById('leaderboard-skeleton');
    const content = document.getElementById('leaderboard-content');
    const tbody = document.getElementById('leaderboard-tbody-g');
    const errEl = document.getElementById('leaderboard-error');
    if (!tbody || !content) return;

    const now = Date.now();
    if (
        now - __leaderboardCache.at < LEADERBOARD_CACHE_TTL_MS &&
        __leaderboardCache.payload
    ) {
        if (loading) loading.hidden = true;
        if (sk) sk.hidden = true;
        content.hidden = false;
        if (errEl) errEl.style.display = 'none';
        applyLeaderboardPayload(__leaderboardCache.payload);
        return;
    }

    if (loading) loading.hidden = false;
    if (sk) sk.hidden = false;
    content.hidden = true;
    if (errEl) {
        errEl.style.display = 'none';
        errEl.textContent = '';
    }
    try {
        const res = await fetch('/api/leaderboard');
        let data;
        try {
            data = await res.json();
        } catch (pe) {
            throw new Error('Invalid leaderboard response');
        }
        if (!res.ok) throw new Error(data.error || 'Failed to load leaderboard');
        __leaderboardCache = { at: Date.now(), payload: data };
        if (loading) loading.hidden = true;
        if (sk) sk.hidden = true;
        content.hidden = false;
        applyLeaderboardPayload(data);
    } catch (err) {
        console.error(err);
        if (loading) loading.hidden = true;
        if (sk) sk.hidden = true;
        content.hidden = true;
        showToast(err.message || 'Could not load leaderboard', 'error');
        if (errEl) {
            errEl.style.display = 'block';
            errEl.textContent = err.message || 'Could not load leaderboard.';
        }
    }
}

function parseBadgeProgressPercent(progress) {
    if (progress == null || progress === '') return 0;
    const s = String(progress)
        .replace(/\s*kg\s*$/i, '')
        .trim();
    const match = s.match(/([\d.]+)\s*\/\s*([\d.]+)/);
    if (!match) return 0;
    const cur = parseFloat(match[1]);
    const need = parseFloat(match[2]);
    if (!Number.isFinite(cur) || !Number.isFinite(need) || need <= 0) return 0;
    return Math.min(100, Math.round((cur / need) * 100));
}

async function loadBadges() {
    const grid = document.getElementById('badges-grid');
    if (!grid) return;
    try {
        const res = await fetch('/api/user/badges');
        const list = await res.json();
        if (!res.ok || !Array.isArray(list)) {
            grid.innerHTML = '<p class="text-sm text-muted">Badges unavailable.</p>';
            return;
        }
        const prevEarned = window.__prevBadgeEarned instanceof Set ? window.__prevBadgeEarned : null;
        const hadSession = window.__badgeSessionStarted === true;
        window.__badgeSessionStarted = true;
        const newlyEarned = [];
        if (hadSession && prevEarned) {
            for (const b of list) {
                if (b.earned && !prevEarned.has(b.name)) newlyEarned.push(b.name);
            }
        }
        window.__prevBadgeEarned = new Set(list.filter((b) => b.earned).map((b) => b.name));

        grid.innerHTML = list
            .map((b) => {
                const earned = Boolean(b.earned);
                const cardCls = earned ? 'badge-card badge-card--earned' : 'badge-card';
                const icon = escapeHtml(b.icon || '🏅');
                const name = escapeHtml(b.name || 'Badge');
                const description = escapeHtml(b.description || '');
                const progressRaw = b.progress != null && b.progress !== '' ? String(b.progress) : '';
                const progressEsc = escapeHtml(progressRaw);
                const pct = parseBadgeProgressPercent(progressRaw);
                const statusEarned = `
                    <div style="display:inline-flex; align-items:center; gap:4px; font-size:0.75em; font-weight:600; color:#166534; background:#f0fdf4; padding:2px 8px; border-radius:4px;">
                        ✅ Earned
                    </div>`;
                const statusLocked = progressRaw
                    ? `
                    <div style="font-size:0.75em; color:#9ca3af;">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <div style="flex:1; min-width:0; background:#e5e7eb; border-radius:4px; height:5px; overflow:hidden;">
                                <div style="background:#4f772d; height:100%; border-radius:4px; width:${pct}%;"></div>
                            </div>
                            <span style="flex-shrink:0;">${progressEsc}</span>
                        </div>
                    </div>`
                    : `<div style="font-size:0.75em; color:#9ca3af;">🔒 Locked</div>`;

                return `
                <div class="card ${cardCls}" data-badge-name="${escapeAttr(b.name)}" style="
                    padding:16px;
                    display:flex;
                    align-items:flex-start;
                    gap:12px;
                    background:${earned ? 'white' : '#fafafa'};
                    border:1px solid ${earned ? '#d3e0d4' : '#e5e7eb'};
                    border-radius:12px;
                    opacity:${earned ? '1' : '0.7'};
                    ${earned ? 'box-shadow:0 2px 8px rgba(79,119,45,0.12);' : ''}
                    cursor:default;
                ">
                    <div style="
                        font-size:1.8em;
                        width:44px;
                        height:44px;
                        display:flex;
                        align-items:center;
                        justify-content:center;
                        border-radius:10px;
                        background:${earned ? '#f0fdf4' : '#f3f4f6'};
                        flex-shrink:0;
                        ${earned ? '' : 'filter:grayscale(1);'}
                    " aria-hidden="true">${icon}</div>
                    <div style="flex:1; min-width:0;">
                        <div style="font-weight:700; font-size:0.9em; color:${earned ? '#132a13' : '#6b7280'}; margin-bottom:2px;">
                            ${name}
                        </div>
                        <div style="font-size:0.8em; color:#6b7280; margin-bottom:6px; line-height:1.35;">
                            ${description}
                        </div>
                        ${earned ? statusEarned : statusLocked}
                    </div>
                </div>`;
            })
            .join('');
        newlyEarned.forEach((name) => {
            showToast(`New badge earned: ${name}!`, 'success');
            grid.querySelectorAll('.badge-card').forEach((el) => {
                if (el.getAttribute('data-badge-name') === name) el.classList.add('badge-card--burst');
            });
        });
    } catch (e) {
        console.error(e);
        grid.innerHTML = '<p class="text-sm text-muted">Could not load badges.</p>';
    }
}

// Event Listeners for Nav + dashboard swap links
document.addEventListener('click', (e) => {
    const emptyCta = e.target.closest('.js-empty-cta-upload');
    if (emptyCta) {
        e.preventDefault();
        switchView('log');
        return;
    }
    const mTab = e.target.closest('.mobile-tab-btn[data-view]');
    if (mTab) {
        e.preventDefault();
        switchView(mTab.dataset.view);
        return;
    }
    const acceptBtn = e.target.closest('.js-accept-swap');
    if (acceptBtn) {
        e.preventDefault();
        if (acceptBtn.disabled || acceptBtn.classList.contains('is-accepted')) return;
        if (acceptBtn.classList.contains('is-accepting')) return;
        const raw = acceptBtn.getAttribute('data-swap-id');
        const swapId = parseInt(raw, 10);
        if (!raw || Number.isNaN(swapId)) return;
        acceptBtn.classList.add('is-accepting');
        (async () => {
            try {
                const res = await fetch('/api/accept-swap', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ swap_id: swapId }),
                });
                const payload = await res.json();
                if (!res.ok) {
                    showToast(payload.error || 'Could not accept swap', 'error');
                    return;
                }
                if (payload.points_awarded) showPointsFloater(payload.points_awarded);
                await refreshDashboardData();
                acceptBtn.disabled = true;
                acceptBtn.classList.remove('is-accepting');
                acceptBtn.classList.add('is-accepted');
                acceptBtn.innerHTML =
                    '<i data-lucide="check" class="swap-accept-icon"></i> Accepted';
                const li = acceptBtn.closest('.dashboard-swap-li');
                if (li) li.classList.add('dashboard-swap-li--accepted');
                const card = acceptBtn.closest('.swap-rec-card');
                if (card) card.classList.add('swap-rec-card--accepted');
                if (window.lucide) window.lucide.createIcons();
                loadBadges();
                const histCard = acceptBtn.closest('.history-receipt-card');
                if (histCard) {
                    const rk = histCard.getAttribute('data-receipt-key');
                    if (rk) loadHistoryReceiptDetail(histCard, rk);
                }
            } catch (err) {
                console.error(err);
                showToast('Network error', 'error');
            } finally {
                acceptBtn.classList.remove('is-accepting');
            }
        })();
        return;
    }
    const swapBtn = e.target.closest('.js-swap-for-receipt');
    if (swapBtn) {
        e.preventDefault();
        const rid = swapBtn.getAttribute('data-receipt-id');
        if (rid) fetchSwapsForDashboard(rid);
        return;
    }
    const navLink = e.target.closest('a.nav-link[data-view]');
    if (navLink) {
        e.preventDefault();
        switchView(navLink.dataset.view);
    }
});

const CHAT_COLLAPSED_KEY = 'ecocart_chat_collapsed';
const CHAT_BREAKPOINT = 1200;

function ensureEcoCartChatVisible() {
    const chatSidebar = document.getElementById('right-chat-sidebar');
    const fab = document.getElementById('chat-fab');
    const backdrop = document.getElementById('chat-modal-backdrop');
    if (!chatSidebar) return;
    const mobile = window.matchMedia(`(max-width: ${CHAT_BREAKPOINT}px)`).matches;
    if (mobile) {
        chatSidebar.classList.add('is-mobile-open');
        document.body.classList.add('chat-mobile-open');
        if (backdrop) {
            backdrop.hidden = false;
            backdrop.classList.add('is-open');
            backdrop.setAttribute('aria-hidden', 'false');
        }
        if (fab) fab.hidden = true;
    } else {
        sessionStorage.setItem(CHAT_COLLAPSED_KEY, '0');
        chatSidebar.classList.remove('is-collapsed');
        chatSidebar.classList.remove('is-mobile-open');
        document.body.classList.remove('chat-mobile-open');
        if (backdrop) {
            backdrop.hidden = true;
            backdrop.classList.remove('is-open');
            backdrop.setAttribute('aria-hidden', 'true');
        }
        if (fab) fab.hidden = true;
    }
    if (window.lucide) window.lucide.createIcons();
}

function isChatMobileLayout() {
    return window.matchMedia(`(max-width: ${CHAT_BREAKPOINT}px)`).matches;
}

function askAIAboutReceipt(receiptKey) {
    if (!receiptKey) return;

    const openChatAndFocusInput = (chatInput) => {
        ensureEcoCartChatVisible();
        const chatSidebar = document.getElementById('right-chat-sidebar');
        if (chatSidebar) {
            chatSidebar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        const sug = document.getElementById('chat-suggestions');
        if (sug && sug.dataset.removing !== '1') {
            sug.dataset.removing = '1';
            sug.dataset.chatHistoryPending = '';
            sug.style.transition = 'opacity 0.3s, max-height 0.3s';
            sug.style.opacity = '0';
            sug.style.maxHeight = '0';
            sug.style.overflow = 'hidden';
            setTimeout(() => {
                sug.remove();
            }, 300);
        }
        if (chatInput) {
            chatInput.focus();
            if (chatInput.setSelectionRange) {
                const len = chatInput.value.length;
                chatInput.setSelectionRange(len, len);
            }
            const sendBtn =
                document.getElementById('chat-send-btn') ||
                document.querySelector('.chat-input-area .btn');
            if (sendBtn) sendBtn.disabled = !chatInput.value.trim();
            const scroller = document.getElementById('chat-scroller');
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
        }
    };

    fetch(`/api/history/${encodeURIComponent(receiptKey)}`)
        .then((res) => {
            if (!res.ok) {
                return fetch('/api/history')
                    .then((r) => r.json())
                    .then((data) => {
                        const receipt = (data.history || []).find(
                            (r) => String(r.receipt_key) === String(receiptKey)
                        );
                        if (!receipt) throw new Error('Receipt not found');
                        return receipt;
                    });
            }
            return res.json();
        })
        .then((receipt) => {
            window.__chatFocusedReceiptId = null;
            const items = (receipt.items || []).map((it) => ({
                item_name: it.item_name || it.name || 'Item',
                brand: (it.brand || '').trim(),
                kg_co2e: it.kg_co2e != null ? Number(it.kg_co2e) : 0,
            }));
            const displayRef =
                receipt.receipt_label || receipt.receipt_key || receiptKey;
            let summary = `Here's what I bought on this receipt (${displayRef}):\n`;
            items.forEach((item) => {
                const brand = item.brand ? ` (${item.brand})` : '';
                const co2 = item.kg_co2e ? ` — ${item.kg_co2e} kg CO₂e` : '';
                summary += `• ${item.item_name}${brand}${co2}\n`;
            });
            let totalCo2 = receipt.total_co2;
            if (totalCo2 == null) {
                totalCo2 = items.reduce((sum, i) => sum + (i.kg_co2e || 0), 0);
            } else {
                totalCo2 = Number(totalCo2);
            }
            summary += `\nTotal: ${totalCo2.toFixed(2)} kg CO₂e`;
            summary += `\n\nMy question: `;

            currentChatReceiptContext = {
                receipt_id: receipt.receipt_id ?? receipt.receipt_key ?? receiptKey,
                items,
                total_co2: totalCo2,
            };

            const chatInput =
                document.getElementById('chat-input-field') ||
                document.getElementById('chat-input') ||
                document.querySelector('.chat-input');
            if (chatInput) {
                chatInput.value = summary;
                if (chatInput.tagName === 'TEXTAREA') {
                    chatInput.style.height = 'auto';
                    chatInput.style.height = `${Math.min(chatInput.scrollHeight, 200)}px`;
                }
                openChatAndFocusInput(chatInput);
                showToast('Receipt loaded — ask EcoCoach AI anything!', 'info');
                if (window.lucide) window.lucide.createIcons();
            } else {
                console.error('Could not find chat input element');
                const clip = summary;
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(clip).then(() => {
                        showToast('Receipt copied to clipboard — paste it in the chat!', 'info');
                    });
                }
            }
        })
        .catch((err) => {
            console.error('Error loading receipt for chat:', err);
            currentChatReceiptContext = null;
            const chatInput =
                document.getElementById('chat-input-field') ||
                document.getElementById('chat-input') ||
                document.querySelector('.chat-input');
            if (chatInput) {
                chatInput.value = `About my receipt ${receiptKey}: `;
                openChatAndFocusInput(chatInput);
                if (chatInput.setSelectionRange) {
                    const len = chatInput.value.length;
                    chatInput.setSelectionRange(len, len);
                }
            }
            showToast('Could not load receipt details, but you can still ask about it!', 'info');
        });
}

window.askAIAboutReceipt = askAIAboutReceipt;

const ECO_COACH_WELCOME =
    "Hi! I'm EcoCoach AI. Ask me about your grocery footprint, swaps, or greener shopping.";

function ecoCoachSuggestionBlockHtml() {
    return `<div class="chat-message message-ai chat-suggestions-block" id="chat-suggestions">
        <p class="text-xs font-bold" style="margin-bottom: 8px;">Try asking EcoCoach AI:</p>
        <div class="chat-suggestion-chips">
            <button type="button" class="chat-suggestion-chip" data-prompt="What's my biggest carbon impact?">What's my biggest carbon impact?</button>
            <button type="button" class="chat-suggestion-chip" data-prompt="Suggest swaps for my last receipt">Suggest swaps for my last receipt</button>
            <button type="button" class="chat-suggestion-chip" data-prompt="How does beef compare to chicken?">How does beef compare to chicken?</button>
            <button type="button" class="chat-suggestion-chip" data-prompt="Tips for a greener grocery list">Tips for a greener grocery list</button>
        </div>
    </div>`;
}

// EcoCoach AI chat
function initChat() {
    const chatSidebar = document.getElementById('right-chat-sidebar');
    const chatInput = document.getElementById('chat-input-field') || document.querySelector('.chat-input');
    const sendBtn = document.getElementById('chat-send-btn') || document.querySelector('.chat-input-area .btn');
    const scroller = document.getElementById('chat-scroller');
    const chatMessages = document.getElementById('chat-messages');
    const fab = document.getElementById('chat-fab');
    const backdrop = document.getElementById('chat-modal-backdrop');
    const collapseBtn = document.getElementById('chat-collapse-btn');
    const mobileCloseBtn = document.getElementById('chat-mobile-close-btn');
    const clearChatBtn = document.getElementById('clear-chat-btn');

    if (!chatInput || !sendBtn || !scroller || !chatMessages || !chatSidebar) return;

    const suggestionsEl = document.getElementById('chat-suggestions');
    if (suggestionsEl) {
        suggestionsEl.dataset.chatHistoryPending = '1';
        suggestionsEl.style.opacity = '0';
        suggestionsEl.style.visibility = 'hidden';
        suggestionsEl.style.pointerEvents = 'none';
    }

    function revealChatSuggestionsForEmptyState() {
        const el = document.getElementById('chat-suggestions');
        if (!el || el.dataset.chatHistoryPending !== '1') return;
        el.dataset.chatHistoryPending = '';
        el.style.opacity = '';
        el.style.visibility = '';
        el.style.pointerEvents = '';
    }

    function hideChatSuggestionsPermanently(immediate) {
        const suggestions = document.getElementById('chat-suggestions');
        if (!suggestions) return;
        if (suggestions.dataset.removing === '1') return;
        suggestions.dataset.removing = '1';
        suggestions.dataset.chatHistoryPending = '';
        if (immediate) {
            suggestions.remove();
            return;
        }
        suggestions.style.transition = 'opacity 0.3s, max-height 0.3s';
        suggestions.style.opacity = '0';
        suggestions.style.maxHeight = '0';
        suggestions.style.overflow = 'hidden';
        suggestions.style.margin = '0';
        suggestions.style.padding = '0';
        setTimeout(() => suggestions.remove(), 300);
    }

    chatInput.disabled = false;

    let chatTypingTimer = null;
    let chatSendReady = true;
    function syncChatSendEnabled() {
        const v = chatInput.value.trim();
        sendBtn.disabled = !v || !chatSendReady;
    }
    function scheduleChatSendEnable() {
        chatSendReady = false;
        sendBtn.disabled = true;
        clearTimeout(chatTypingTimer);
        chatTypingTimer = setTimeout(() => {
            chatSendReady = true;
            syncChatSendEnabled();
        }, 300);
    }
    chatInput.addEventListener('input', () => {
        scheduleChatSendEnable();
        if (chatInput.tagName === 'TEXTAREA') {
            chatInput.style.height = 'auto';
            chatInput.style.height = `${Math.min(chatInput.scrollHeight, 200)}px`;
        }
    });
    syncChatSendEnabled();

    function scrollChatToBottom() {
        scroller.scrollTop = scroller.scrollHeight;
    }

    function appendMessage(type, text) {
        const msg = document.createElement('div');
        msg.className = `chat-message message-${type === 'user' ? 'user' : 'ai'}`;
        msg.textContent = text;
        chatMessages.appendChild(msg);
        scrollChatToBottom();
        return msg;
    }

    function appendTypingIndicator() {
        const wrap = document.createElement('div');
        wrap.className = 'chat-message message-ai chat-typing-indicator';
        wrap.innerHTML =
            '<span class="typing-dot" aria-hidden="true"></span><span class="typing-dot" aria-hidden="true"></span><span class="typing-dot" aria-hidden="true"></span>';
        wrap.setAttribute('aria-label', 'EcoCoach AI is typing');
        chatMessages.appendChild(wrap);
        scrollChatToBottom();
        return wrap;
    }

    function applyChatLayout() {
        const mobile = isChatMobileLayout();
        chatSidebar.classList.toggle('is-mobile-layout', mobile);
        if (mobile) {
            chatSidebar.classList.remove('is-collapsed');
            const open = chatSidebar.classList.contains('is-mobile-open');
            if (backdrop) {
                backdrop.hidden = !open;
                backdrop.classList.toggle('is-open', open);
                backdrop.setAttribute('aria-hidden', open ? 'false' : 'true');
            }
            if (fab) fab.hidden = open;
        } else {
            chatSidebar.classList.remove('is-mobile-open');
            if (backdrop) {
                backdrop.hidden = true;
                backdrop.classList.remove('is-open');
                backdrop.setAttribute('aria-hidden', 'true');
            }
            const collapsed = sessionStorage.getItem(CHAT_COLLAPSED_KEY) === '1';
            chatSidebar.classList.toggle('is-collapsed', collapsed);
            if (fab) fab.hidden = !collapsed;
        }
        if (window.lucide) window.lucide.createIcons();
    }

    function setDesktopCollapsed(collapsed) {
        if (isChatMobileLayout()) return;
        sessionStorage.setItem(CHAT_COLLAPSED_KEY, collapsed ? '1' : '0');
        applyChatLayout();
    }

    function openMobileChat() {
        if (!isChatMobileLayout()) return;
        chatSidebar.classList.add('is-mobile-open');
        document.body.classList.add('chat-mobile-open');
        applyChatLayout();
        chatInput.focus();
    }

    function closeMobileChat() {
        chatSidebar.classList.remove('is-mobile-open');
        document.body.classList.remove('chat-mobile-open');
        applyChatLayout();
    }

    window.addEventListener('resize', () => applyChatLayout());
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && chatSidebar.classList.contains('is-mobile-open')) {
            closeMobileChat();
        }
    });
    applyChatLayout();

    if (fab) {
        fab.addEventListener('click', () => {
            if (isChatMobileLayout()) openMobileChat();
            else {
                sessionStorage.setItem(CHAT_COLLAPSED_KEY, '0');
                chatSidebar.classList.remove('is-collapsed');
                applyChatLayout();
            }
        });
    }

    if (collapseBtn) {
        collapseBtn.addEventListener('click', () => {
            if (isChatMobileLayout()) return;
            setDesktopCollapsed(true);
        });
    }

    if (mobileCloseBtn) {
        mobileCloseBtn.addEventListener('click', () => closeMobileChat());
    }

    if (backdrop) {
        backdrop.addEventListener('click', () => closeMobileChat());
    }

    async function loadChatHistory() {
        try {
            const response = await fetch('/api/chat-history');
            if (response.status === 401) {
                appendMessage('ai', ECO_COACH_WELCOME);
                revealChatSuggestionsForEmptyState();
                return;
            }
            const data = await response.json();
            if (!Array.isArray(data) || data.length === 0) {
                appendMessage('ai', ECO_COACH_WELCOME);
                revealChatSuggestionsForEmptyState();
                return;
            }
            data.forEach((row) => {
                const role = row.role === 'user' ? 'user' : 'ai';
                appendMessage(role, row.content || '');
            });
        } catch (e) {
            console.warn('Chat history load failed', e);
            appendMessage('ai', ECO_COACH_WELCOME);
            revealChatSuggestionsForEmptyState();
        }
    }

    loadChatHistory();

    async function performChatClear() {
        try {
            const res = await fetch('/api/chat/clear', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            let data = {};
            try {
                data = await res.json();
            } catch {
                /* ignore */
            }
            if (!res.ok) throw new Error(data.error || 'Failed to clear chat');
            chatMessages.innerHTML = '';
            document.getElementById('chat-suggestions')?.remove();
            chatInput.value = '';
            if (chatInput.tagName === 'TEXTAREA') {
                chatInput.style.height = 'auto';
                chatInput.style.height = '40px';
            }
            currentChatReceiptContext = null;
            chatSendReady = true;
            syncChatSendEnabled();
            appendMessage('ai', ECO_COACH_WELCOME);
            scroller.insertAdjacentHTML('beforeend', ecoCoachSuggestionBlockHtml());
            if (window.lucide) window.lucide.createIcons();
            scrollChatToBottom();
            showToast('Chat cleared', 'info');
        } catch (e) {
            console.error(e);
            showToast(e.message || 'Failed to clear chat', 'error');
        }
    }

    window.clearChat = function clearChat() {
        if (!confirm('Clear all chat history? This cannot be undone.')) return;
        void performChatClear();
    };

    clearChatBtn?.addEventListener('click', () => window.clearChat());

    async function handleSend() {
        const query = chatInput.value.trim();
        if (!query || !chatSendReady) return;

        hideChatSuggestionsPermanently(false);

        let payloadQuery = query;
        const rid = window.__chatFocusedReceiptId;
        if (rid && !currentChatReceiptContext) {
            payloadQuery = `Regarding my receipt ${rid}: ${query}`;
        }

        const payload = { query: payloadQuery };
        if (currentChatReceiptContext) {
            payload.receipt_context = currentChatReceiptContext;
            currentChatReceiptContext = null;
        }

        appendMessage('user', query);
        chatInput.value = '';
        if (chatInput.tagName === 'TEXTAREA') {
            chatInput.style.height = 'auto';
            chatInput.style.height = '40px';
        }
        syncChatSendEnabled();

        const typingEl = appendTypingIndicator();

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            let result;
            try {
                result = await response.json();
            } catch (parseErr) {
                typingEl.remove();
                showToast('Invalid chat response', 'error');
                appendMessage('ai', 'Something went wrong. Please try again.');
                return;
            }
            typingEl.remove();

            if (!response.ok) {
                const msg = result.error || 'Chat request failed';
                showToast(msg, 'error');
                appendMessage('ai', msg);
                return;
            }

            if (result.response) {
                appendMessage('ai', result.response);
            } else if (result.error) {
                showToast(result.error, 'error');
                appendMessage('ai', result.error);
            } else {
                appendMessage('ai', "I'm sorry, I couldn't generate a reply. Please try again.");
            }
        } catch (err) {
            typingEl.remove();
            showToast('Error connecting to EcoCoach AI.', 'error');
            appendMessage('ai', 'Error connecting to EcoCoach AI.');
        }
    }

    window.__ecoCoachSendSuggestion = function sendSuggestion(text) {
        if (!text) return;
        chatInput.value = text;
        chatSendReady = true;
        syncChatSendEnabled();
        handleSend();
    };
    window.sendSuggestion = function (text) {
        window.__ecoCoachSendSuggestion?.(text);
    };

    sendBtn.addEventListener('click', handleSend);
    chatInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        if (e.shiftKey) return;
        e.preventDefault();
        if (!chatInput.value.trim() || !chatSendReady) return;
        handleSend();
    });

    scroller.addEventListener('click', (e) => {
        const chip = e.target.closest('.chat-suggestion-chip');
        if (!chip || !scroller.contains(chip)) return;
        const p = chip.getAttribute('data-prompt');
        if (!p) return;
        e.preventDefault();
        window.__ecoCoachSendSuggestion(p);
    });

    const historyContainer = document.getElementById('history-container');
    if (historyContainer) {
        historyContainer.addEventListener('click', (e) => {
            const genBtn = e.target.closest('.js-history-generate-swaps');
            if (genBtn) {
                e.preventDefault();
                runHistoryGenerateSwaps(genBtn);
                return;
            }
            const hdr = e.target.closest('.history-card-header');
            if (hdr) {
                e.preventDefault();
                const card = hdr.closest('.history-receipt-card');
                if (card) toggleHistoryReceiptCard(card);
            }
        });
        historyContainer.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const hdr = e.target.closest('.history-card-header');
            if (!hdr) return;
            e.preventDefault();
            const card = hdr.closest('.history-receipt-card');
            if (card) toggleHistoryReceiptCard(card);
        });
    }
}

function removeDashboardStatSkeletonGhosts() {
    document.getElementById('dashboard-stat-skeleton')?.remove();
    document.querySelectorAll('#view-dashboard .dashboard-stat-skeleton').forEach((el) => el.remove());
}

window.resetLogView = resetLogView;

// Initial View
window.addEventListener('DOMContentLoaded', () => {
    removeDashboardStatSkeletonGhosts();
    switchView('dashboard');
    initChat();

    document.getElementById('sl-optimize-btn')?.addEventListener('click', () => optimizeSmartList());
    document.getElementById('sl-copy-btn')?.addEventListener('click', () => copySmartList());
    document.getElementById('sl-store-btn')?.addEventListener('click', () => findItemsInStore());

    document.getElementById('sl-content')?.addEventListener('change', (e) => {
        const t = e.target;
        if (t.matches?.('.sl-item-check')) {
            toggleSmartListItem(t.dataset.itemId, t.checked);
        }
    });
    document.getElementById('sl-content')?.addEventListener('click', (e) => {
        if (e.target.closest?.('.js-sl-goto-upload')) {
            e.preventDefault();
            switchView('log');
        }
    });
});
