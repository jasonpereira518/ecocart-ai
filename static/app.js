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
    }

    // Re-create icons for new content
    if (window.lucide) {
        window.lucide.createIcons();
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
                        <button class="btn btn-primary btn-sm" onclick="window.location.reload()">Refresh Footprint</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    if (window.lucide) {
        window.lucide.createIcons();
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

// Initial View
window.addEventListener('DOMContentLoaded', () => {
    switchView('dashboard');
});
