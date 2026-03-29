document.addEventListener('DOMContentLoaded', () => {
    
    // --- UI TOGGLE LOGIC ---
    const targetStateDropdown = document.getElementById('targetState');
    const txInputGroup = document.getElementById('tx-input-group');
    const flInputGroup = document.getElementById('fl-input-group');
    const modeBadge = document.getElementById('mode-badge');

    function syncUI() {
        const selected = targetStateDropdown.value;
        if (selected === 'TX') {
            txInputGroup.classList.remove('hidden');
            flInputGroup.classList.add('hidden');
            if (modeBadge) modeBadge.textContent = 'TEXAS TARGETING';
        } else if (selected === 'FL') {
            txInputGroup.classList.add('hidden');
            flInputGroup.classList.remove('hidden');
            if (modeBadge) modeBadge.textContent = 'FLORIDA TARGETING';
        } else if (selected === 'NATIONAL') {
            // UNHIDES BOTH INSTANTLY FOR PARALLEL
            txInputGroup.classList.remove('hidden');
            flInputGroup.classList.remove('hidden');
            if (modeBadge) modeBadge.textContent = 'NATIONAL SWARM';
        }
    }

    targetStateDropdown.addEventListener('change', syncUI);
    syncUI(); 
    // -----------------------

    const runBtn = document.getElementById('runBtn');
    const btnText = document.getElementById('btnText');
    const container = document.getElementById('ai-data-container');
    const title = document.getElementById('resultsTitle');
    
    const terminalWrapper = document.getElementById('terminalWrapper');
    const terminal = document.getElementById('terminal');
    const workerCluster = document.getElementById('workerCluster'); 

    function formatUSDate(dateString) {
        if (!dateString) return "";
        const [year, month, day] = dateString.split('-');
        return `${month}/${day}/${year}`;
    }

    function initializeGrid(state) {
        workerCluster.innerHTML = "";
        workerCluster.classList.remove('hidden');
        title.innerHTML = "Monitoring Live Swarm Agents...";
        title.classList.remove('hidden');

        const labels = state === 'NATIONAL' 
            ? ['TEXAS (Phase 1: Search)', 'FLORIDA (Phase 1: Search)', 'TEXAS (Phase 2: Extract)', 'FLORIDA (Phase 2: Extract)'] 
            : ['AGENT 01 (Search)', 'AGENT 02 (Extract)'];
        
        labels.forEach((label, i) => {
            workerCluster.innerHTML += `
                <div class="worker-mini-card active" id="worker-card-${i}">
                    <div class="worker-label">
                        <span>NODE_0${i+1}</span>
                        <span class="pulse-dot"></span>
                    </div>
                    <div class="worker-id-tag" style="color: #38bdf8;">${label}</div>
                    
                    <div class="worker-video-frame">
                        <iframe id="worker-iframe-${i}" style="width: 100%; height: 100%; border: none; background: #000;" src=""></iframe>
                    </div>

                    <div class="worker-status-text" id="worker-status-${i}">Waiting for connection...</div>
                    <div class="worker-progress-bar">
                        <div class="worker-progress-fill" id="worker-fill-${i}" style="width: 5%;"></div>
                    </div>
                </div>
            `;
        });
    }

    runBtn.addEventListener('click', async () => {
        const targetState = document.getElementById('targetState').value; 
        const txClassCode = document.getElementById('txClassCode').value;
        const flCommodityCode = document.getElementById('flCommodityCode').value;
        const startDate = formatUSDate(document.getElementById('startDate').value);
        const endDate = formatUSDate(document.getElementById('endDate').value);

        btnText.innerHTML = "Swarm Deployed...";
        runBtn.style.opacity = "0.7";
        runBtn.style.pointerEvents = "none"; 
        
        container.innerHTML = "";
        container.classList.add('hidden');
        
        initializeGrid(targetState);

        terminalWrapper.classList.remove('hidden');
        terminal.innerHTML = `> Initializing Secure Connection to GovTrack Swarm Server...<br>`;

        try {
            const response = await fetch('/api/run-agent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetState, txClassCode, flCommodityCode, startDate, endDate }) 
            });

            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8");

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                const chunk = decoder.decode(value);
                const lines = chunk.split('\n');
                
                for (let line of lines) {
                    if (line.startsWith('data: ')) {
                        const dataStr = line.substring(6).trim();
                        if (!dataStr) continue;
                        
                        try {
                            const parsedData = JSON.parse(dataStr);

                            // 🔥 THE FIX: Catch the SCOUT stream and route it
                            if (parsedData.type === 'SCOUT_STREAM') {
                                const scoutIframe = document.getElementById(`worker-iframe-${parsedData.scoutIndex}`);
                                if (scoutIframe && (!scoutIframe.src || scoutIframe.src === window.location.href)) {
                                    setTimeout(() => {
                                        scoutIframe.src = parsedData.url;
                                    }, parsedData.scoutIndex * 500); 
                                }
                            }

                            // Catch the WORKER stream and route it
                            if (parsedData.type === 'WORKER_STREAM') {
                                const workerIframe = document.getElementById(`worker-iframe-${parsedData.workerIndex}`);
                                if (workerIframe && (!workerIframe.src || workerIframe.src === window.location.href)) {
                                    setTimeout(() => {
                                        workerIframe.src = parsedData.url;
                                    }, parsedData.workerIndex * 500); 
                                }
                            }

                            // Catch SCOUT Logs
                            if (parsedData.type === 'SCOUT_LOG') {
                                const statusEl = document.getElementById(`worker-status-${parsedData.scoutIndex}`);
                                const fillEl = document.getElementById(`worker-fill-${parsedData.scoutIndex}`);
                                if (statusEl && fillEl) {
                                    statusEl.innerText = parsedData.text;
                                    const currentWidth = parseInt(fillEl.style.width) || 10;
                                    if (currentWidth < 90) fillEl.style.width = `${currentWidth + 10}%`;
                                }
                            }

                            // Catch WORKER Logs
                            if (parsedData.type === 'WORKER_LOG') {
                                const statusEl = document.getElementById(`worker-status-${parsedData.workerIndex}`);
                                const fillEl = document.getElementById(`worker-fill-${parsedData.workerIndex}`);
                                if (statusEl && fillEl) {
                                    statusEl.innerText = parsedData.text;
                                    const currentWidth = parseInt(fillEl.style.width) || 10;
                                    if (currentWidth < 90) fillEl.style.width = `${currentWidth + 10}%`;
                                }
                            }

                            // Terminal Logs
                            if (parsedData.type === 'LOG') {
                                terminal.innerHTML += `> ${parsedData.text}<br>`;
                                terminal.scrollTop = terminal.scrollHeight;
                            }
                            
                            // Errors
                            if (parsedData.type === 'ERROR') {
                                terminal.innerHTML += `<span class="error" style="color: #ff4444;">> ERROR: ${parsedData.text}</span><br>`;
                                terminal.scrollTop = terminal.scrollHeight;
                            }
                            
                            // Completion
                            if (parsedData.type === 'COMPLETE') {
                                terminal.innerHTML += `<span class="success" style="color: #00ffcc;">> SUCCESS: Swarm Extraction Complete. Compiling UI...</span><br>`;
                                terminal.scrollTop = terminal.scrollHeight;
                                
                                document.querySelectorAll('.worker-mini-card').forEach(card => {
                                    card.classList.remove('active');
                                    card.classList.add('complete');
                                    const statusText = card.querySelector('.worker-status-text');
                                    if(statusText) statusText.innerText = "DATA SYNCED";
                                    const fill = card.querySelector('.worker-progress-fill');
                                    if(fill) fill.style.width = "100%";
                                });

                                renderCards(parsedData.data.contracts);
                            }
                        } catch (err) {}
                    }
                }
            }

        } catch (error) {
            terminal.innerHTML += `<span class="error" style="color: #ff4444;">> SYSTEM FAILURE: ${error.message}</span><br>`;
        } finally {
            btnText.innerHTML = "✨ Deploy Swarm";
            runBtn.style.opacity = "1";
            runBtn.style.pointerEvents = "auto";
        }
    });

    function renderCards(contracts) {
        title.innerHTML = `Extracted Deep Intelligence`;
        
        contracts.forEach((contract, index) => {
            if (contract.error) {
                container.innerHTML += `<div class="card" style="border: 1px solid #ef4444;"><p style="color: #ef4444;">Worker Error for ID: ${contract.solicitation_id || 'Unknown'}</p><small>${contract.error}</small></div>`;
                return;
            }

            const scope = contract.scope_of_work ? contract.scope_of_work.replace(/\n/g, '<br><br>') : "No scope detailed.";
            const compliance = contract.compliance || "No specific compliance items listed.";
            
            let docsHTML = "";
            if (contract.documents && contract.documents.length > 0) {
                contract.documents.forEach(doc => {
                    docsHTML += `<a href="${doc.url}" target="_blank" style="display: block; color: #3b82f6; font-size: 0.85rem; margin-top: 5px;">📄 ${doc.name || 'Document'}</a>`;
                });
            } else {
                docsHTML = "<span style='color: #94a3b8; font-size: 0.85rem;'>No documents attached.</span>";
            }

            const cardHTML = `
                <div class="card" style="animation-delay: ${index * 0.2}s; background: #1e293b; padding: 20px; border-radius: 10px; border: 1px solid #334155; margin-bottom: 15px; color: white;">
                    <div class="card-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                        <div>
                            <span class="worker-badge" style="background: ${contract.state === 'TX' ? '#2563eb' : '#f59e0b'}; color: white; padding: 3px 8px; border-radius: 4px; font-weight: bold; font-size: 0.8rem;">${contract.state || 'WORKER'}</span>
                            <span style="color: #94a3b8; font-size: 0.8rem; margin-left: 10px;">ID: ${contract.solicitation_id}</span>
                        </div>
                        <div style="text-align: right;">
                            <div style="color: #cbd5e1; font-size: 0.75rem;">Posted: ${contract.posting_date || 'N/A'}</div>
                            <div class="due-date" style="color: #fca5a5; font-size: 0.8rem; font-weight: bold;">⏱ Due: ${contract.due_date || 'N/A'}</div>
                        </div>
                    </div>
                    <h3 class="agency-name" style="margin: 0 0 15px 0; font-size: 1.2rem; color: #f8fafc;">${contract.agency || 'Agency Data Missing'}</h3>
                    
                    <div class="summary-box">
                        <strong style="color: #10b981; text-transform: uppercase; font-size: 0.8rem;">Deep Scope of Work</strong><br>
                        ${scope}
                    </div>

                    <div style="display: flex; gap: 15px; margin-top: 15px;">
                        <div style="flex: 1; background: rgba(0,0,0,0.2); padding: 12px; border-radius: 8px;">
                            <strong style="color: #cbd5e1; font-size: 0.8rem;">🛡️ Compliance & Certs</strong>
                            <p style="font-size: 0.85rem; color: #94a3b8; margin-top: 5px;">${compliance}</p>
                        </div>
                        <div style="flex: 1; background: rgba(0,0,0,0.2); padding: 12px; border-radius: 8px;">
                            <strong style="color: #cbd5e1; font-size: 0.8rem;">👤 Purchaser Contact</strong>
                            <p style="font-size: 0.85rem; color: #94a3b8; margin-top: 5px; line-height: 1.4;">
                                ${contract.contact_name || 'N/A'}<br>
                                📞 ${contract.contact_phone || 'N/A'}<br>
                                ✉️ ${contract.contact_email || 'N/A'}
                            </p>
                        </div>
                    </div>

                    <div style="margin-top: 15px; padding: 12px; border-top: 1px solid rgba(255,255,255,0.1);">
                        <strong style="color: white; font-size: 0.9rem;">Attached Documents</strong>
                        <div style="margin-top: 8px;">${docsHTML}</div>
                    </div>
                    
                    <div class="action-row" style="margin-top: 20px; display: flex; gap: 10px;">
                        <button class="btn btn-pdf" style="background: transparent; border: 1px solid #3b82f6; color: white; padding: 10px; border-radius: 6px; cursor: pointer;" onclick="window.open('${contract.solicitation_url}', '_blank')">🌐 Open Origin URL</button>
                        <button class="btn-bonfire" style="background: #f97316; border: none; color: white; padding: 10px; border-radius: 6px; cursor: pointer; font-weight: bold; flex: 1;" onclick="alert('Syncing full data payload to Bonfire...')">
                            🔥 Sync to Bonfire
                        </button>
                    </div>
                </div>
            `;
            container.innerHTML += cardHTML;
        });

        container.classList.remove('hidden');
    }
});