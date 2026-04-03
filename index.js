require('dotenv').config();
const express = require('express');
const cors = require('cors'); 

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); 

// ==========================================
// 1. PROMPT LIBRARY
// ==========================================
const PROMPTS = {
    TX: {
        scout: (code, start, end, limit) => `Go to https://www.txsmartbuy.gov/esbd. 1. Click "Status", select "Posted". 2. Click the calendar icon next to "Start Date". Use the calendar popup to change the month if necessary, then click the exact day for ${start}. 3. Click the calendar icon next to "End Date", use the popup to navigate, and click the exact day for ${end}. Do NOT type dates directly. 4. Enter Class Code ${code} and click Search. 5. Extract the Solicitation IDs for the TOP ${limit} results. Return STRICT JSON: { "ids": ["ID1"] }`,
        
        worker: (id) => `Go to https://www.txsmartbuy.gov/esbd/${id}. Extract page details. Return STRICT JSON: { "agency": "", "solicitation_id": "${id}", "posting_date": "", "due_date": "", "scope_of_work": "Summarize", "compliance": "List certs", "contact_name": "", "contact_phone": "", "contact_email": "", "documents": [{"name": "", "url": "Extract href"}], "solicitation_url": "https://www.txsmartbuy.gov/esbd/${id}" }`
      },
   FL: {
        scout: (code, start, end, limit) => `Go to https://vendor.myfloridamarketplace.com/search/bids. 1. Set "Ad Status" dropdown to "OPEN". 2. Set "Ad Type" dropdown to "Request for Proposals". 3. Type "${code}" in the search box. 4. Set Start Date to ${start} and End Date to ${end}. 5. Click Search. 6. Look at the results table. Extract the value from the "Number" column (the blue hyperlink, e.g., RFP-15363) for the top ${limit} results. Do NOT extract the Agency Advertisement Number. Return EXACTLY JSON: { "ids": ["ID1"] }`,
        
        worker: (id) => `Go to https://vendor.myfloridamarketplace.com/search/bids. 1. Type "${id}" in the search box and click Search. 2. Click the specific blue link for "${id}" to open the solicitation. 3. Extract the page details. Return EXACTLY JSON: { "agency": "Extracted Agency", "solicitation_id": "${id}", "posting_date": "Date", "due_date": "Date", "scope_of_work": "Summary", "compliance": "List certs", "contact_name": "Name", "contact_phone": "Phone", "contact_email": "Email", "documents": [{"name": "Doc Name", "url": "Extract href"}], "solicitation_url": "The current URL" }`
    }
};

// ==========================================
// 2. TIMEOUT-PROOF ASYNC ENGINE (Poller)
// ==========================================
async function fireAgent(url, goal) {
    const res = await fetch('https://agent.tinyfish.ai/v1/automation/run-async', {
        method: 'POST',
        headers: { 'X-API-Key': process.env.TINYFISH_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, goal })
    });
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()).run_id; 
}

async function pollAgent(runId, callbacks = {}) {
    let sentUrl = false;
    let lastStep = 0;

    while (true) {
        await new Promise(r => setTimeout(r, 2000)); // Poll every 2 seconds
        try {
            const res = await fetch(`https://agent.tinyfish.ai/v1/runs/${runId}`, {
                headers: { 'X-API-Key': process.env.TINYFISH_API_KEY }
            });
            if (!res.ok) continue; 
            
            const run = await res.json();

            if (run.streaming_url && !sentUrl) {
                sentUrl = true;
                if (callbacks.onUrl) callbacks.onUrl(run.streaming_url);
            }

            if (run.num_of_steps !== null && run.num_of_steps > lastStep) {
                lastStep = run.num_of_steps;
                if (callbacks.onProgress) callbacks.onProgress(`Executing step ${lastStep}...`);
            }

            if (run.status === 'COMPLETED') return run.result;
            if (run.status === 'FAILED') throw new Error(run.error?.message || 'Agent failed.');
            if (run.status === 'CANCELLED') throw new Error('Agent cancelled.');
        } catch (err) {
            if (err.message.includes('failed') || err.message.includes('cancelled')) throw err;
        }
    }
}

// ==========================================
// 3. THE SPLIT-LOGIC API ROUTE (SEQUENTIAL ONLY)
// ==========================================
app.post('/api/run-agent', async (req, res) => {
  const { targetState, txClassCode, flCommodityCode, startDate, endDate } = req.body;
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    
    // ---------------------------------------------------------
    // BRANCH A: NATIONAL SWARM (Texas First, Then Florida)
    // ---------------------------------------------------------
    if (targetState === 'NATIONAL') {
        res.write(`data: ${JSON.stringify({ type: 'LOG', text: `⚡ NATIONAL OVERRIDE: Launching scout swarm sequentially...` })}\n\n`);
        
        // Step 1: Signal frontend to prepare the grid
        res.write(`data: ${JSON.stringify({ type: 'SCOUT_PHASE_START' })}\n\n`);

        const runDirectPipeline = async (state, code, searchUrl, scoutIndex) => {
            try {
                const workerIndex = scoutIndex + 2; // Pushes Workers to Box 3 and 4

                // Phase 1: Scout streams live into scout box
                res.write(`data: ${JSON.stringify({ type: 'SCOUT_LOG', scoutIndex, text: 'Searching portal...' })}\n\n`);
                const scoutId = await fireAgent(searchUrl, PROMPTS[state].scout(code, startDate, endDate, 1));
                const scoutResult = await pollAgent(scoutId, {
                    onUrl: (url) => res.write(`data: ${JSON.stringify({ type: 'SCOUT_STREAM', scoutIndex, url })}\n\n`),
                    onProgress: (msg) => res.write(`data: ${JSON.stringify({ type: 'SCOUT_LOG', scoutIndex, text: msg })}\n\n`)
                });

                const foundId = scoutResult?.ids?.[0];
                if (!foundId) throw new Error("No target found.");

                res.write(`data: ${JSON.stringify({ type: 'SCOUT_LOG', scoutIndex, text: `✅ Target acquired: ${foundId}` })}\n\n`);

                // Phase 2: Signal worker box to open, stream into it
                res.write(`data: ${JSON.stringify({ type: 'WORKER_PHASE_START', workerIndex, foundId, state })}\n\n`);

                const workerUrl = state === 'TX' ? `https://www.txsmartbuy.gov/esbd/${foundId}` : `https://vendor.myfloridamarketplace.com/search/bids`;
                const workerRunId = await fireAgent(workerUrl, PROMPTS[state].worker(foundId));
                const finalResult = await pollAgent(workerRunId, {
                    onUrl: (url) => res.write(`data: ${JSON.stringify({ type: 'WORKER_STREAM', workerIndex, url })}\n\n`),
                    onProgress: (msg) => res.write(`data: ${JSON.stringify({ type: 'WORKER_LOG', workerIndex, text: msg })}\n\n`)
                });

                finalResult.state = state;
                return finalResult;
            } catch (err) {
                return { error: err.message, state: state };
            }
        };

        const finalContracts = [];
        
        // strictly execute Texas first
        res.write(`data: ${JSON.stringify({ type: 'LOG', text: `⏳ Starting Texas Pipeline...` })}\n\n`);
        const txResult = await runDirectPipeline('TX', txClassCode, "https://www.txsmartbuy.gov/esbd", 0);
        finalContracts.push(txResult);

        // strictly execute Florida second, after Texas finishes
        res.write(`data: ${JSON.stringify({ type: 'LOG', text: `✅ Texas Complete. Starting Florida Pipeline...` })}\n\n`);
        const flResult = await runDirectPipeline('FL', flCommodityCode, "https://vendor.myfloridamarketplace.com/search/bids", 1);
        finalContracts.push(flResult);

        res.write(`data: ${JSON.stringify({ type: 'COMPLETE', data: { contracts: finalContracts } })}\n\n`);
        return res.end();
    } 
    
    // ---------------------------------------------------------
    // BRANCH B: SINGLE STATE (Worker 1 first, then Worker 2)
    // ---------------------------------------------------------
    else {
        res.write(`data: ${JSON.stringify({ type: 'LOG', text: `🔍 Initiating Sequential Extraction for ${targetState}...` })}\n\n`);
        
        const code = targetState === 'TX' ? txClassCode : flCommodityCode;
        const searchUrl = targetState === 'TX' ? "https://www.txsmartbuy.gov/esbd" : "https://vendor.myfloridamarketplace.com/search/bids";

        // Phase 1: Scout
        res.write(`data: ${JSON.stringify({ type: 'SCOUT_PHASE_START' })}\n\n`);
        const scoutRunId = await fireAgent(searchUrl, PROMPTS[targetState].scout(code, startDate, endDate, 2));
        const scoutResult = await pollAgent(scoutRunId, {
            onUrl: (url) => res.write(`data: ${JSON.stringify({ type: 'SCOUT_STREAM', scoutIndex: 0, url })}\n\n`),
            onProgress: (msg) => res.write(`data: ${JSON.stringify({ type: 'LOG', text: `[Scout] ${msg}` })}\n\n`)
        });

        const targetIds = scoutResult?.ids || [];
        if (targetIds.length === 0) {
            res.write(`data: ${JSON.stringify({ type: 'LOG', text: "⚠️ No solicitations found." })}\n\n`);
            return res.end();
        }

        res.write(`data: ${JSON.stringify({ type: 'LOG', text: `🎯 Phase 1 Done. IDs: ${targetIds.join(', ')}` })}\n\n`);

        // Phase 2: Open worker grid sequentially
        res.write(`data: ${JSON.stringify({ type: 'PHASE_2_START', ids: targetIds })}\n\n`);

        const finalContracts = [];
        
        // strictly execute each worker sequentially using a for loop
        for (let index = 0; index < targetIds.length; index++) {
            const id = targetIds[index];
            const workerUrl = targetState === 'TX' ? `https://www.txsmartbuy.gov/esbd/${id}` : `https://vendor.myfloridamarketplace.com/search/bids`;
            
            try {
                res.write(`data: ${JSON.stringify({ type: 'LOG', text: `⏳ Running Worker ${index + 1} for ID: ${id}...` })}\n\n`);
                const workerRunId = await fireAgent(workerUrl, PROMPTS[targetState].worker(id));
                const finalResult = await pollAgent(workerRunId, {
                    onUrl: (url) => res.write(`data: ${JSON.stringify({ type: 'WORKER_STREAM', workerIndex: index, url })}\n\n`),
                    onProgress: (msg) => res.write(`data: ${JSON.stringify({ type: 'WORKER_LOG', workerIndex: index, text: msg })}\n\n`)
                });
                finalResult.state = targetState;
                finalContracts.push(finalResult);
                res.write(`data: ${JSON.stringify({ type: 'LOG', text: `✅ Worker ${index + 1} complete.` })}\n\n`);
            } catch (err) {
                finalContracts.push({ error: err.message, state: targetState, solicitation_id: id });
            }
        }

        res.write(`data: ${JSON.stringify({ type: 'COMPLETE', data: { contracts: finalContracts } })}\n\n`);
        res.end();
    }

  } catch (error) {
    res.write(`data: ${JSON.stringify({ type: 'ERROR', text: "Critical System Failure." })}\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('=================================');
  console.log(`⚡️ GovTrack Split-Architecture is ONLINE on port ${PORT}`);
  console.log(' Dashboard: http://localhost:3000');
});