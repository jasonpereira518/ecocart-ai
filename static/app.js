function switchView(viewName) {
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
    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.toggle('active', link.dataset.view === viewName);
    });

    if (viewName === 'log') {
        initUpload();
        resetLogView();
    }

    // Re-create icons for new content
    if (window.lucide) {
        window.lucide.createIcons();
    }
}

// Reset the Log View UI
function resetLogView() {
    const feedback = document.getElementById('ai-feedback');
    if (!feedback) return;
    
    // Hide the results but restore the loading template for next time
    feedback.style.display = 'none';
    feedback.innerHTML = `
        <div class="processing-container pulse">
            <div style="display: flex; gap: 1rem; align-items: center;">
                <i data-lucide="loader" class="pulse"></i>
                <p class="text-sm font-bold">AI Analyzing your receipt...</p>
            </div>
        </div>
    `;
    if (window.lucide) window.lucide.createIcons();
}

// Global Refresh Suite
async function refreshAllData() {
    await Promise.all([
        refreshDashboardData(),
        refreshHistoryView()
    ]);
}

// File Upload Logic
function initUpload() {
// ... existing initUpload logic skipped to use replace_file_content properly ...
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
        feedback.style.display = 'block';
        feedback.scrollIntoView({ behavior: 'smooth' });

        try {
            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });
            const result = await response.json();
            
            if (result.status === 'success') {
                displayAIResults(result.filename, result.data);
            } else {
                alert("Upload failed: " + result.error);
            }
        } catch (err) {
            console.error(err);
            alert("An error occurred during upload.");
        }
    };
}

// Dynamic AI Rendering
function displayAIResults(filename, data) {
    const feedback = document.getElementById('ai-feedback');
    
    // Construct the items list dynamically
    let itemsHtml = '';
    if (data && data.length > 0) {
        data.forEach(item => {
            // Pick a simple icon based on category
            let icon = '🛒';
            if (item.category === 'Food') icon = '🍽️';
            else if (item.category === 'Transport') icon = '🚗';
            else if (item.category === 'Energy') icon = '⚡';
            
            // Format footprint coloring
            // Format footprint coloring
            let fpColor = 'var(--text-muted)';
            if (item.kg_co2e > 5) fpColor = 'var(--accent)';
            else if (item.kg_co2e < 1.5) fpColor = 'var(--green-impact)';
            
            itemsHtml += `
                <li>${icon} <span class="font-bold">${item.item_name}</span> 
                → <span style="color: ${fpColor}; font-weight: 700;">${Number(item.kg_co2e).toFixed(2)} kg CO2e</span></li>
            `;
        });
    } else {
        itemsHtml = '<li>No items cleanly extracted.</li>';
    }

    feedback.innerHTML = `
        <div class="card" style="border-left: 4px solid var(--primary-dark); animation: slideIn 0.3s ease-out;">
            <div style="display: flex; gap: 1rem;">
                <div class="ai-icon">
                    <i data-lucide="check-circle"></i>
                </div>
                <div>
                    <p class="text-sm font-bold">Receipt Parsed Successfully</p>
                    <p class="text-xs text-muted mb-2">Source: ${filename}</p>
                    <p class="text-sm mt-1">Here is the carbon footprint breakdown of your items:</p>
                    <ul style="font-size: 0.875rem; color: var(--text-muted); margin-top: 0.8rem; list-style: none; display: flex; flex-direction: column; gap: 0.5rem;">
                        ${itemsHtml}
                    </ul>
                    <div class="mt-4">
                        <button class="btn btn-primary btn-sm" onclick="refreshAllData(); switchView('dashboard');">Close & Refresh</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    if (window.lucide) {
        window.lucide.createIcons();
    }
}

// Dynamic Dashboard Refresh
async function refreshDashboardData() {
    try {
        const response = await fetch('/api/stats');
        const data = await response.json();
        
        // Update Stats
        document.getElementById('stat-total-co2').innerHTML = `${data.total_co2} <span class="text-sm font-normal">kg CO2e</span>`;
        document.getElementById('stat-points').innerHTML = `${data.points} <span class="text-sm font-normal">TerraPoints</span>`;
        document.getElementById('stat-milestone').innerHTML = `${data.points % 100}<span class="text-sm font-normal">/100</span>`;
        
        // Update Recent Activities
        const listContainer = document.getElementById('dashboard-recent-activities');
        if (data.recent_activities && data.recent_activities.length > 0) {
            let html = '';
            data.recent_activities.forEach(a => {
                let colorClass = '';
                if (a.kg_co2e > 5) colorClass = 'text-high-impact';
                else if (a.kg_co2e < 1.5) colorClass = 'text-low-impact';
                
                html += `
                    <div style="display: flex; align-items: center; justify-content: space-between; padding: 1rem; border-bottom: 1px solid var(--border);">
                        <div style="display: flex; gap: 0.75rem; align-items: center;">
                            <div style="background: #f1f5f9; padding: 0.5rem; border-radius: 8px;">
                                <i data-lucide="shopping-bag" size="18"></i>
                            </div>
                            <div>
                                <p class="text-sm font-bold">${a.item_name}</p>
                                <p class="text-xs text-muted">Recent Purchase</p>
                            </div>
                        </div>
                        <p class="text-sm font-bold ${colorClass}">${a.kg_co2e.toFixed(2)}kg</p>
                    </div>
                `;
            });
            listContainer.innerHTML = html;
            if (window.lucide) window.lucide.createIcons();
        }
    } catch (err) {
        console.error("Dashboard refresh error:", err);
    }
}

async function refreshHistoryView() {
    try {
        const response = await fetch('/api/history');
        const data = await response.json();
        const container = document.getElementById('history-container');
        if (!container || !data.history) return;

        let html = '';
        data.history.forEach(receipt => {
            let rowsHtml = '';
            receipt.items.forEach(item => {
                let colorClass = '';
                if (item.kg_co2e > 5) colorClass = 'text-high-impact';
                else if (item.kg_co2e < 1.5) colorClass = 'text-low-impact';

                rowsHtml += `
                    <tr style="border-bottom: 1px solid #f8fafc;">
                        <td style="padding: 0.875rem 0;">
                            <div style="display: flex; gap: 0.5rem; align-items: center;">
                                <i data-lucide="shopping-tag" size="14"></i>
                                <span class="text-sm font-bold">${item.name}</span>
                            </div>
                        </td>
                        <td style="padding: 0.875rem 0;"><span class="text-xs" style="background: var(--bg-main); padding: 2px 8px; border-radius: 4px;">${item.category}</span></td>
                        <td style="padding: 0.875rem 0; text-align: right;">
                            <span class="text-sm font-bold ${colorClass}">${item.kg_co2e.toFixed(2)}kg</span>
                        </td>
                    </tr>
                `;
            });

            html += `
                <div class="card" style="padding: 0; overflow: hidden;">
                    <div style="background: var(--bg-main); padding: 1rem 1.5rem; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <p class="text-xs font-bold uppercase tracking-wider text-muted">Receipt Entry</p>
                            <h3 class="text-lg" style="margin: 0;">${receipt.receipt_id}</h3>
                        </div>
                        <div style="text-align: right;">
                            <p class="text-xs text-muted">Date Logged</p>
                            <p class="text-sm font-bold">${receipt.date}</p>
                        </div>
                    </div>
                    <div style="padding: 1rem 1.5rem;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <thead>
                                <tr style="border-bottom: 1px solid var(--border);">
                                    <th style="text-align: left; padding: 0.75rem 0; font-size: 0.75rem; text-transform: uppercase;" class="text-muted">Item Description</th>
                                    <th style="text-align: left; padding: 0.75rem 0; font-size: 0.75rem; text-transform: uppercase;" class="text-muted">Category</th>
                                    <th style="text-align: right; padding: 0.75rem 0; font-size: 0.75rem; text-transform: uppercase;" class="text-muted">Footprint</th>
                                </tr>
                            </thead>
                            <tbody>${rowsHtml}</tbody>
                            <tfoot>
                                <tr>
                                    <td colspan="2" style="padding-top: 1rem; text-align: right; font-size: 0.875rem;" class="text-muted">Receipt Total:</td>
                                    <td style="padding-top: 1rem; text-align: right; font-size: 0.875rem; font-weight: 700;">${receipt.total_co2}kg CO2e</td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </div>
            `;
        });
        container.innerHTML = html;
        if (window.lucide) window.lucide.createIcons();
    } catch (err) {
        console.error("History refresh error:", err);
    }
}

// Event Listeners for Nav
document.addEventListener('click', (e) => {
    const navLink = e.target.closest('.nav-link');
    if (navLink) {
        e.preventDefault();
        const view = navLink.dataset.view;
        switchView(view);
    }
});

// AI Coach Chat Logic
function initChat() {
    const chatInput = document.querySelector('.chat-input');
    const sendBtn = document.querySelector('.chat-input-area .btn');
    const scroller = document.getElementById('chat-scroller');

    if (!chatInput || !sendBtn) return;

    // Enable inputs
    chatInput.disabled = false;
    sendBtn.disabled = false;
    document.querySelector('.chat-input-area p').style.display = 'none';

    async function handleSend() {
        const query = chatInput.value.trim();
        if (!query) return;

        // Append User Message
        appendMessage('user', query);
        chatInput.value = '';

        // Typing indicator or state
        const loadingMsg = appendMessage('ai', 'Thinking...');

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query })
            });
            const result = await response.json();
            
            loadingMsg.remove();
            
            if (result.response) {
                appendMessage('ai', result.response);
            } else {
                appendMessage('ai', "I'm sorry, I'm having trouble connecting to my brain right now.");
            }
        } catch (err) {
            loadingMsg.remove();
            appendMessage('ai', "Error connecting to the coach.");
        }
    }

    function appendMessage(type, text) {
        const msg = document.createElement('div');
        msg.className = `chat-message message-${type}`;
        msg.innerText = text;
        scroller.appendChild(msg);
        scroller.scrollTop = scroller.scrollHeight;
        return msg;
    }

    sendBtn.onclick = handleSend;
    chatInput.onkeypress = (e) => {
        if (e.key === 'Enter') handleSend();
    };
}

// Initial View
window.addEventListener('DOMContentLoaded', () => {
    switchView('dashboard');
    initChat();
});
