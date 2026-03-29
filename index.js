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
// ==========================================
// 1. PROMPT LIBRARY
// ==========================================
const PROMPTS = {
    TX: {
        // Texas: Updated to strictly use the calendar popup for dates
        scout: (code, start, end, limit) => `Go to https://www.txsmartbuy.gov/esbd. 1. Click "Status", select "Posted". 2. Click the calendar icon next to "Start Date". Use the calendar popup to change the month if necessary, then click the exact day for ${start}. 3. Click the calendar icon next to "End Date", use the popup to navigate, and click the exact day for ${end}. Do NOT type dates directly. 4. Enter Class Code ${code} and click Search. 5. Extract the Solicitation IDs for the TOP ${limit} results. Return STRICT JSON: { "ids": ["ID1"] }`,
        
        worker: (id) => `Go to https://www.txsmartbuy.gov/esbd/${id}. Extract page details. Return STRICT JSON: { "agency": "", "solicitation_id": "${id}", "posting_date": "", "due_date": "", "scope_of_work": "Summarize", "compliance": "List certs", "contact_name": "", "contact_phone": "", "contact_email": "", "documents": [{"name": "", "url": "Extract href"}], "solicitation_url": "https://www.txsmartbuy.gov/esbd/${id}" }`
      },
    FL: {
        // Florida: Updated to search by Advertisement Number instead of Commodity Code
        scout: (code, start, end, limit) => `Go to https://vendor.myfloridamarketplace.com/search/bids. 1. Expand "Ad Status", select "OPEN". 2. Expand "Ad Type", select "Request for Proposals". 3. Locate the "Advertisement Number" search box and type exactly "${code}". 4. Set the dates from ${start} to ${end}. 5. Click Search. Extract the Advertisement Number for the TOP ${limit} results. Return STRICT JSON: { "ids": ["ID1"] }`,
        
        worker: (id) => `Go to https://vendor.myfloridamarketplace.com/search/bids. Search for "${id}". Click link for "${id}". Scroll to bottom. Extract. Return STRICT JSON: { "agency": "Extract Org", "solicitation_id": "${id}", "posting_date": "", "due_date": "", "scope_of_work": "Summarize", "compliance": "Extract certs", "contact_name": "", "contact_phone": "", "contact_email": "", "documents": [{"name": "", "url": "Extract href"}], "solicitation_url": "The current URL" }`
    }
};
// ==========================================
// 2. TIMEOUT-PROOF ASYNC ENGINE
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
        await new Promise(r => setTimeout(r, 2000)); 
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
// 3. THE SPLIT-LOGIC API ROUTE
// ==========================================
app.post('/api/run-agent', async (req, res) => {
  const { targetState, txClassCode, flCommodityCode, startDate, endDate } = req.body;
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    
    // ---------------------------------------------------------
    // BRANCH A: NATIONAL SWARM
    // ---------------------------------------------------------
    if (targetState === 'NATIONAL') {
        res.write(`data: ${JSON.stringify({ type: 'LOG', text: `⚡ NATIONAL OVERRIDE: Launching parallel scout swarm...` })}\n\n`);
        
        // Step 1: Signal frontend to prepare the grid
        res.write(`data: ${JSON.stringify({ type: 'SCOUT_PHASE_START' })}\n\n`);

        const runDirectPipeline = async (state, code, searchUrl, scoutIndex) => {
            try {
                const workerIndex = scoutIndex + 2; // 🔥 KEY MATH: Pushes Workers to Box 3 and 4

                // Phase 1: Scout streams live into scout box (Boxes 0 and 1)
                res.write(`data: ${JSON.stringify({ type: 'SCOUT_LOG', scoutIndex, text: 'Searching portal...' })}\n\n`);
                const scoutId = await fireAgent(searchUrl, PROMPTS[state].scout(code, startDate, endDate, 1));
                const scoutResult = await pollAgent(scoutId, {
                    onUrl: (url) => res.write(`data: ${JSON.stringify({ type: 'SCOUT_STREAM', scoutIndex, url })}\n\n`),
                    onProgress: (msg) => res.write(`data: ${JSON.stringify({ type: 'SCOUT_LOG', scoutIndex, text: msg })}\n\n`)
                });

                const foundId = scoutResult?.ids?.[0];
                if (!foundId) throw new Error("No target found.");

                res.write(`data: ${JSON.stringify({ type: 'SCOUT_LOG', scoutIndex, text: `✅ Target acquired: ${foundId}` })}\n\n`);

                // Phase 2: Signal worker box to open, stream into it (Boxes 2 and 3)
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

        const finalContracts = await Promise.all([
            runDirectPipeline('TX', txClassCode, "https://www.txsmartbuy.gov/esbd", 0),
            runDirectPipeline('FL', flCommodityCode, "https://vendor.myfloridamarketplace.com/search/bids", 1)
        ]);

        res.write(`data: ${JSON.stringify({ type: 'COMPLETE', data: { contracts: finalContracts } })}\n\n`);
        return res.end();
    } 
    
    // ---------------------------------------------------------
    // BRANCH B: SINGLE STATE
    // ---------------------------------------------------------
    else {
        res.write(`data: ${JSON.stringify({ type: 'LOG', text: `🔍 Initiating 2-Agent Swarm for ${targetState}...` })}\n\n`);
        
        const code = targetState === 'TX' ? txClassCode : flCommodityCode;
        const searchUrl = targetState === 'TX' ? "https://www.txsmartbuy.gov/esbd" : "https://vendor.myfloridamarketplace.com/search/bids";

        // Phase 1: Scout — stream into the single scout box
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

        // Phase 2: Open worker grid
        res.write(`data: ${JSON.stringify({ type: 'PHASE_2_START', ids: targetIds })}\n\n`);

        const workerPromises = targetIds.map(async (id, index) => {
            const workerUrl = targetState === 'TX' ? `https://www.txsmartbuy.gov/esbd/${id}` : `https://vendor.myfloridamarketplace.com/search/bids`;
            try {
                const workerRunId = await fireAgent(workerUrl, PROMPTS[targetState].worker(id));
                const finalResult = await pollAgent(workerRunId, {
                    onUrl: (url) => res.write(`data: ${JSON.stringify({ type: 'WORKER_STREAM', workerIndex: index, url })}\n\n`),
                    onProgress: (msg) => res.write(`data: ${JSON.stringify({ type: 'WORKER_LOG', workerIndex: index, text: msg })}\n\n`)
                });
                finalResult.state = targetState;
                return finalResult;
            } catch (err) {
                return { error: err.message, state: targetState, solicitation_id: id };
            }
        });

        const finalContracts = await Promise.all(workerPromises);
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
  console.log('=================================');
});