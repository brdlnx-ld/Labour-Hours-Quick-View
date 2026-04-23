// ==UserScript==
// @name         Labour Hours Quick View
// @namespace    http://tampermonkey.net/
// @version      6.0
// @description  UK rollout - MAN8/SNG1/LBA8/BHX8, 8am-8am windows, table week view, light/dark mode
// @author       brdlnx
// @match        https://fclm-portal.amazon.com/*warehouseId=LCY8*
// @match        https://fclm-portal.amazon.com/*warehouseId=STN8*
// @match        https://fclm-portal.amazon.com/*warehouseId=SXW2*
// @match        https://fclm-portal.amazon.com/*warehouseId=SBS2*
// @match        https://fclm-portal.amazon.com/*warehouseId=MAN8*
// @match        https://fclm-portal.amazon.com/*warehouseId=SNG1*
// @match        https://fclm-portal.amazon.com/*warehouseId=LBA8*
// @match        https://fclm-portal.amazon.com/*warehouseId=BHX8*
// @grant        GM_xmlhttpRequest
// @connect      fclm-portal.amazon.com
// @updateURL    https://github.com/brdlnx-ld/Labour-Hours-Quick-View/raw/refs/heads/main/Labour%20Hours%20Quick%20View-6.0.user.js
// @downloadURL  https://github.com/brdlnx-ld/Labour-Hours-Quick-View/raw/refs/heads/main/Labour%20Hours%20Quick%20View-6.0.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
'use strict';

const AVAILABLE_SITES = ['LCY8','STN8','SXW2','SBS2','MAN8','SNG1','LBA8','BHX8'];
const DEFAULT_SITE = 'LCY8';
const NODE_TYPE = 'SC';
let refreshInterval = 10 * 60000;
const BATCH_SIZE = 12;
const BATCH_DELAY = 0;
const WEEK_1_START = new Date('2025-12-28T00:00:00');
let currentTheme = localStorage.getItem('lhqv-theme') || 'dark';

const SITE_WINDOWS = {
    LCY8: {
        shifts: {
            DAY:   { label: 'Day (08:30\u201319:00)',   startHour: 8,  startMinute: 30, endHour: 19, endMinute: 0,  crossesMidnight: false },
            NIGHT: { label: 'Night (19:00\u201304:30)', startHour: 19, startMinute: 0,  endHour: 4,  endMinute: 30, crossesMidnight: true  }
        },
        defaultShift: 'DAY', hasShiftSelector: true
    },
    STN8: { shifts: { EOS: { label: 'EOS (08:00\u201308:00+1)', startHour: 8, startMinute: 0, endHour: 8, endMinute: 0, crossesMidnight: true } }, defaultShift: 'EOS', hasShiftSelector: false },
    SBS2: { shifts: { EOS: { label: 'EOS (08:00\u201308:00+1)', startHour: 8, startMinute: 0, endHour: 8, endMinute: 0, crossesMidnight: true } }, defaultShift: 'EOS', hasShiftSelector: false },
    SXW2: { shifts: { EOS: { label: 'EOS (08:00\u201308:00+1)', startHour: 8, startMinute: 0, endHour: 8, endMinute: 0, crossesMidnight: true } }, defaultShift: 'EOS', hasShiftSelector: false },
    MAN8: { shifts: { EOS: { label: 'EOS (08:00\u201308:00+1)', startHour: 8, startMinute: 0, endHour: 8, endMinute: 0, crossesMidnight: true } }, defaultShift: 'EOS', hasShiftSelector: false },
    SNG1: { shifts: { EOS: { label: 'EOS (08:00\u201308:00+1)', startHour: 8, startMinute: 0, endHour: 8, endMinute: 0, crossesMidnight: true } }, defaultShift: 'EOS', hasShiftSelector: false },
    LBA8: { shifts: { EOS: { label: 'EOS (08:00\u201308:00+1)', startHour: 8, startMinute: 0, endHour: 8, endMinute: 0, crossesMidnight: true } }, defaultShift: 'EOS', hasShiftSelector: false },
    BHX8: { shifts: { EOS: { label: 'EOS (08:00\u201308:00+1)', startHour: 8, startMinute: 0, endHour: 8, endMinute: 0, crossesMidnight: true } }, defaultShift: 'EOS', hasShiftSelector: false }
};

const TRACKED_PROCESSES = {
    "SC Training":            { processId: 100391, label: 'SC Training [100391]' },
    "Admin/HR":               { processId: 100200, label: 'Admin/HR [100200]', filter: { attribute: 'JOB_ROLE', values: ['LN_FC_TRAING_EVENTS','LN_TDRCLASSRM_TRAING'] } },
    "Learning Ambassadors":   { processId: 100384, label: 'Learning Ambassadors [100384]' },
    "Day 1 and 2 Insturctors":{ processId: 100385, label: 'New Hires [100385]', filter: { attribute: 'JOB_ROLE', values: ['AMB NEW HIRE TRAINING'] } },
    "Day 1":                  { processId: 100243, label: 'On Boarding [100243]' },
    "Day 2":                  { processId: 100385, label: 'New Hires [100385]', filter: { attribute: 'JOB_ROLE', values: ['NEW HIRE TRAINING'] } }
};

const CATEGORY_TREE = [
    { name: 'Training Hours', flat: true, processKeys: ['SC Training','Admin/HR'] },
    { name: 'Instructor', children: [
        { name: 'Instructor',              processKeys: ['Learning Ambassadors'] },
        { name: 'Day 1 and 2 Insturctors', processKeys: ['Day 1 and 2 Insturctors'] }
    ]},
    { name: 'New Hires', children: [
        { name: 'Day 1', processKeys: ['Day 1'] },
        { name: 'Day 2', processKeys: ['Day 2'] }
    ]}
];


const rates = {};
let selectedSite = detectSiteFromUrl();
let loadedCount = 0;
let totalToLoad = Object.keys(TRACKED_PROCESSES).length;
let refreshGeneration = 0;
let lastRefresh = null;
let selectedShift = null;
let selectedDate = null;
let selectedViewMode = 'DAY';
let lastAutoShift = null;
let refreshTimerId = null;
let countdownTimerId = null;
let refreshPaused = false;
let nextRefreshAt = null;
let isDashboardOpen = false;

const dataCache = {};
const categoryState = {};
const subCategoryState = {};
const breakoutState = {};
const processState = {};

function detectSiteFromUrl() {
    const href = window.location.href;
    for (const site of AVAILABLE_SITES) { if (href.includes('warehouseId=' + site)) return site; }
    return DEFAULT_SITE;
}
function getSiteConfig()        { return SITE_WINDOWS[selectedSite] || SITE_WINDOWS[DEFAULT_SITE]; }
function getAvailableShifts()   { return getSiteConfig().shifts; }
function getDefaultShiftForSite(){ return getSiteConfig().defaultShift; }
function siteUsesShiftSelector(){ return !!getSiteConfig().hasShiftSelector; }
function getEffectiveShift()    { const s = getAvailableShifts(); return (selectedShift && s[selectedShift]) ? selectedShift : getDefaultShiftForSite(); }
function getShiftWindow(k)      { const s = getAvailableShifts(); return s[k] || s[getDefaultShiftForSite()]; }
function pad2(n)                { return String(n).padStart(2,'0'); }
function fmtYMD(d)              { return d.getFullYear()+'/'+pad2(d.getMonth()+1)+'/'+pad2(d.getDate()); }
function fmtISODate(d)          { return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }
function addDays(d,n)           { const t=new Date(d); t.setDate(t.getDate()+n); return t; }
function todayStr()             { return fmtISODate(new Date()); }

function inferShift() {
    const shifts = getAvailableShifts();
    if (!siteUsesShiftSelector()) return getDefaultShiftForSite();
    if (selectedShift && shifts[selectedShift]) return selectedShift;
    const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const keys = Object.keys(shifts);
    for (let i=0;i<keys.length;i++) {
        const win = shifts[keys[i]];
        const start = new Date(today); start.setHours(win.startHour, win.startMinute, 0, 0);
        const end = new Date(today);
        if (win.crossesMidnight) end.setDate(end.getDate()+1);
        end.setHours(win.endHour, win.endMinute, 0, 0);
        if (now >= start && now <= end) return keys[i];
        if (win.crossesMidnight) {
            const yStart = addDays(start,-1); const yEnd = addDays(end,-1);
            if (now >= yStart && now <= yEnd) return keys[i];
        }
    }
    return getDefaultShiftForSite();
}

function getOperationalNowBaseDate() {
    let base = new Date();
    const win = getShiftWindow(getEffectiveShift());
    if (win.crossesMidnight) {
        const h=base.getHours(),m=base.getMinutes();
        if (h < win.endHour || (h===win.endHour && m<=win.endMinute)) base = addDays(base,-1);
    }
    return new Date(base.getFullYear(), base.getMonth(), base.getDate());
}

function getWeekStart(dateLike) {
    const d = new Date(dateLike);
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return addDays(dayStart, -dayStart.getDay());
}
function getWeekNumber(dateLike) {
    const thisWeekStart = getWeekStart(new Date(dateLike));
    const week1Start = new Date(WEEK_1_START.getFullYear(), WEEK_1_START.getMonth(), WEEK_1_START.getDate());
    return Math.floor(Math.floor((thisWeekStart - week1Start) / 86400000) / 7) + 1;
}
function getWeekDatesForSelectedContext() {
    const baseDate = selectedDate ? new Date(selectedDate+'T12:00:00') : getOperationalNowBaseDate();
    const weekStart = getWeekStart(baseDate);
    const dates = [];
    for (let i=0;i<7;i++) dates.push(addDays(weekStart,i));
    return dates;
}
function getWeekLabelText() {
    const baseDate = selectedDate ? new Date(selectedDate+'T12:00:00') : getOperationalNowBaseDate();
    const weekNo = getWeekNumber(baseDate);
    const weekStart = getWeekStart(baseDate);
    const weekEnd = addDays(weekStart,6);
    return 'Week '+weekNo+' \u00b7 '+fmtISODate(weekStart)+' to '+fmtISODate(weekEnd);
}
function getCacheKey() {
    return selectedSite+'|'+selectedViewMode+'|'+(selectedDate||todayStr())+'|'+getEffectiveShift();
}
function isHistorical() { return selectedDate && selectedDate !== todayStr(); }

function resetRefreshTimer() {
    if (refreshTimerId) clearInterval(refreshTimerId);
    if (countdownTimerId) clearInterval(countdownTimerId);
    if (refreshPaused) return;
    nextRefreshAt = Date.now() + refreshInterval;
    refreshTimerId = setInterval(autoRefresh, refreshInterval);
    startCountdown();
}
function startCountdown() {
    if (countdownTimerId) clearInterval(countdownTimerId);
    countdownTimerId = setInterval(function(){
        if (refreshPaused || !nextRefreshAt) return;
        const remaining = Math.max(0, nextRefreshAt - Date.now());
        const mins = Math.floor(remaining/60000);
        const secs = Math.floor((remaining%60000)/1000);
        const el = document.getElementById('lhqv-countdown');
        if (el) { el.textContent = '\u23f1 '+mins+':'+String(secs).padStart(2,'0'); el.style.color = remaining < 60000 ? '#fbbf24' : '#64748b'; }
    }, 1000);
}
function stopCountdown() {
    if (countdownTimerId) clearInterval(countdownTimerId);
    countdownTimerId = null;
    const el = document.getElementById('lhqv-countdown');
    if (el) { el.textContent = '\u23f8 Paused'; el.style.color = '#f59e0b'; }
}
function togglePause() {
    refreshPaused = !refreshPaused;
    const btn = document.getElementById('lhqv-pause-btn');
    if (refreshPaused) {
        if (refreshTimerId) clearInterval(refreshTimerId); refreshTimerId=null;
        stopCountdown();
        if (btn){ btn.textContent='\u25b6 Resume'; btn.classList.remove('lhqv-btn-warning'); btn.classList.add('lhqv-btn-success'); }
        updateStatus('Auto-refresh paused','error');
    } else {
        if (btn){ btn.textContent='\u23f8 Pause'; btn.classList.remove('lhqv-btn-success'); btn.classList.add('lhqv-btn-warning'); }
        resetRefreshTimer(); updateStatus('Auto-refresh resumed','ok');
    }
}


function buildPPAUrl(processConfig, forcedDateStr, forcedShiftKey) {
    let base = forcedDateStr ? new Date(forcedDateStr+'T12:00:00') : (selectedDate ? new Date(selectedDate+'T12:00:00') : new Date());
    const shiftKey = forcedShiftKey || getEffectiveShift();
    const win = getShiftWindow(shiftKey);
    if (!forcedDateStr && !selectedDate && win.crossesMidnight) {
        const h=base.getHours(),m=base.getMinutes();
        if (h < win.endHour || (h===win.endHour && m<=win.endMinute)) base = addDays(base,-1);
    }
    const startDate = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    const endDate = win.crossesMidnight ? addDays(startDate,1) : startDate;
    return 'https://fclm-portal.amazon.com/ppa/inspect/process'
        +'?nodeType='+NODE_TYPE+'&warehouseId='+selectedSite
        +'&processId='+processConfig.processId
        +'&primaryAttribute=JOB_ROLE&secondaryAttribute=JOB_ROLE&spanType=Intraday'
        +'&startDateDay='+encodeURIComponent(fmtYMD(startDate))
        +'&startDateIntraday='+encodeURIComponent(fmtYMD(startDate))
        +'&startHourIntraday='+win.startHour+'&startMinuteIntraday='+win.startMinute
        +'&endDateIntraday='+encodeURIComponent(fmtYMD(endDate))
        +'&endHourIntraday='+win.endHour+'&endMinuteIntraday='+win.endMinute
        +'&maxIntradayDays=1';
}

function extractProductivityList(html) {
    try {
        const match = html.match(/filteredProductivityList\s*=\s*(\[[\s\S]*?\]);\s*(?:var|let|const|\/\/|function|\n)/);
        if (match) return JSON.parse(match[1]);
    } catch(e){}
    const marker = 'filteredProductivityList = [';
    let startIdx = html.indexOf(marker);
    if (startIdx === -1) return null;
    startIdx += marker.length - 1;
    let depth = 0;
    for (let i=startIdx;i<html.length;i++) {
        if (html[i]==='[') depth++;
        if (html[i]===']') depth--;
        if (depth===0) { try { return JSON.parse(html.substring(startIdx,i+1)); } catch(e){ return null; } }
    }
    return null;
}

function getCandidateValues(pa, attrName) {
    const out=[]; const tk=String(attrName).toLowerCase();
    if (pa && pa[attrName]!=null) out.push(String(pa[attrName]).trim());
    for (const key in pa||{}) { if (String(key).toLowerCase()===tk && pa[key]!=null) out.push(String(pa[key]).trim()); }
    const nested=(pa&&pa.attributes)||{};
    if (nested[attrName]!=null) out.push(String(nested[attrName]).trim());
    for (const key in nested) { if (String(key).toLowerCase()===tk && nested[key]!=null) out.push(String(nested[key]).trim()); }
    return Array.from(new Set(out.filter(Boolean)));
}
function valueMatchesFilter(pa, filter) {
    if (!filter) return true;
    const wanted=(filter.values||(filter.value?[filter.value]:[])).map(v=>String(v).trim());
    if (!wanted.length) return true;
    return getCandidateValues(pa, filter.attribute).some(c=>wanted.includes(c));
}
function getBreakoutValue(pa, pc) {
    if (!pa) return 'UNSPECIFIED';
    const attrName = (pc&&pc.breakoutAttribute) ? pc.breakoutAttribute : 'JOB_ROLE';
    return getCandidateValues(pa,attrName)[0]||'UNSPECIFIED';
}

function aggregateData(productivityList, processLabel, processConfig) {
    if (!rates[processLabel]) rates[processLabel]={ workers:{}, breakouts:{} };
    const store=rates[processLabel];
    const filter=processConfig&&processConfig.filter?processConfig.filter:null;
    for (let i=0;i<productivityList.length;i++) {
        const entry=productivityList[i]; const pa=entry.processAttributes||{};
        if (filter && !valueMatchesFilter(pa,filter)) continue;
        const trackingType=pa.laborTrackingType||'';
        const associates=entry.associateProductivityList||[];
        const bv=getBreakoutValue(pa,processConfig);
        if (!store.breakouts[bv]) store.breakouts[bv]={ name:bv, workers:{} };
        const seen={};
        for (let j=0;j<associates.length;j++) {
            const a=associates[j]; const empId=a.employeeId;
            if (!empId||seen[empId]) continue; seen[empId]=true;
            const hours=Number(a.timeMillis||a.timeSeconds||0)/3600;
            const name=a.employeeName||'', mgr=a.managerName||'';
            if (!store.workers[empId]) store.workers[empId]={ employeeId:empId, employeeName:name, managerName:mgr, totalDirect:0, totalIndirect:0, totalHrs:0 };
            if (!store.breakouts[bv].workers[empId]) store.breakouts[bv].workers[empId]={ employeeId:empId, employeeName:name, managerName:mgr, totalDirect:0, totalIndirect:0, totalHrs:0 };
            const wr=store.workers[empId]; const bwr=store.breakouts[bv].workers[empId];
            if (trackingType==='direct'){ wr.totalDirect+=hours; bwr.totalDirect+=hours; }
            else { wr.totalIndirect+=hours; bwr.totalIndirect+=hours; }
            wr.totalHrs=wr.totalDirect+wr.totalIndirect;
            bwr.totalHrs=bwr.totalDirect+bwr.totalIndirect;
        }
    }
}

function loadProcess(processLabel, processConfig, onDone, thisGen, forcedDateStr, forcedShiftKey) {
    const url = buildPPAUrl(processConfig, forcedDateStr, forcedShiftKey);
    GM_xmlhttpRequest({
        method:'GET', url:url, timeout:15000,
        onload: function(r){ if (thisGen!==refreshGeneration) return; if (r.status>=200&&r.status<300){ const list=extractProductivityList(r.responseText); if (list) aggregateData(list,processLabel,processConfig); onDone(processLabel,!!list); } else onDone(processLabel,false); },
        onerror:   function(){ onDone(processLabel,false); },
        ontimeout: function(){ onDone(processLabel,false); }
    });
}


function refreshData() {
    const cacheKey = getCacheKey();
    if (isHistorical() && dataCache[cacheKey]) {
        for (const key in rates) delete rates[key];
        const cached=dataCache[cacheKey];
        for (const key in cached) rates[key]=JSON.parse(JSON.stringify(cached[key]));
        lastRefresh=new Date(); updateHeaderBadges(); renderTable(); resetRefreshTimer();
        updateStatus('Loaded from cache \u00b7 '+selectedSite,'ok'); return;
    }
    refreshGeneration++;
    const thisGen=refreshGeneration;
    for (const key in rates) delete rates[key];
    const entries=Object.entries(TRACKED_PROCESSES);
    const failedProcesses=[]; let workItems=[];
    if (selectedViewMode==='DAY') {
        totalToLoad=entries.length;
        const fds=selectedDate||null, fsk=getEffectiveShift();
        entries.forEach(function(e){ workItems.push({label:e[0],config:e[1],dateStr:fds,shiftKey:fsk}); });
    } else {
        const weekDates=getWeekDatesForSelectedContext();
        const shiftsToLoad=(selectedSite==='LCY8')?Object.keys(getAvailableShifts()):[getEffectiveShift()];
        totalToLoad=entries.length*weekDates.length*shiftsToLoad.length;
        weekDates.forEach(function(dateObj){
            const dateStr=fmtISODate(dateObj);
            shiftsToLoad.forEach(function(shiftKey){
                entries.forEach(function(e){ workItems.push({label:e[0],config:e[1],dateStr:dateStr,shiftKey:shiftKey}); });
            });
        });
    }
    loadedCount=0;
    updateStatus('Loading 0/'+totalToLoad+'...','loading');
    function onProcessDone(lbl,success) {
        if (thisGen!==refreshGeneration) return;
        if (!success) failedProcesses.push(lbl);
        loadedCount++;
        updateStatus('Loading '+loadedCount+'/'+totalToLoad+'...','loading');
        renderTable();
        if (loadedCount>=totalToLoad) {
            lastRefresh=new Date(); updateHeaderBadges();
            let msg;
            if (selectedViewMode==='WEEK') { msg='Loaded \u00b7 '+selectedSite+' \u00b7 '+getWeekLabelText()+((selectedSite==='LCY8')?' \u00b7 Day+Night':'')+' \u00b7 '+lastRefresh.toLocaleTimeString(); }
            else { msg='Loaded \u00b7 '+selectedSite+' \u00b7 '+(selectedDate||'Today')+' \u00b7 '+getShiftWindow(getEffectiveShift()).label+' \u00b7 '+lastRefresh.toLocaleTimeString(); }
            if (failedProcesses.length>0) msg+=' \u00b7 '+failedProcesses.length+' failed';
            updateStatus(msg, failedProcesses.length>0?'error':'ok');
            if (isHistorical()) { dataCache[cacheKey]={}; for (const k in rates) dataCache[cacheKey][k]=JSON.parse(JSON.stringify(rates[k])); }
        }
    }
    function launchBatch(startIndex) {
        if (thisGen!==refreshGeneration) return;
        const end=Math.min(startIndex+BATCH_SIZE,workItems.length);
        for (let i=startIndex;i<end;i++) { const item=workItems[i]; loadProcess(item.label,item.config,onProcessDone,thisGen,item.dateStr,item.shiftKey); }
        if (end<workItems.length) setTimeout(function(){ launchBatch(end); }, BATCH_DELAY);
    }
    launchBatch(0); resetRefreshTimer();
}

function normaliseProcessData(procKey) {
    const procData=rates[procKey]||{workers:{},breakouts:{}};
    const workers=Object.values(procData.workers||{}).sort((a,b)=>b.totalHrs-a.totalHrs);
    const breakouts=Object.keys(procData.breakouts||{}).map(function(bn){
        const br=procData.breakouts[bn];
        const bw=Object.values(br.workers||{}).sort((a,b)=>b.totalHrs-a.totalHrs);
        return { name:bn, associates:bw.length, totalHrs:bw.reduce((s,w)=>s+w.totalHrs,0), workers:bw };
    }).sort((a,b)=>b.totalHrs!==a.totalHrs?b.totalHrs-a.totalHrs:a.name.localeCompare(b.name));
    return { processKey:procKey, processLabel:TRACKED_PROCESSES[procKey].label||procKey, associates:workers.length, totalHrs:workers.reduce((s,w)=>s+w.totalHrs,0), workers:workers, breakouts:breakouts };
}

function collectWorkersForProcessKeys(processKeys) {
    const workersMap={}; let totalHrs=0; const processBreakdowns=[];
    processKeys.forEach(function(procKey){
        const pn=normaliseProcessData(procKey); processBreakdowns.push(pn);
        pn.workers.forEach(function(r){
            if (!workersMap[r.employeeId]) workersMap[r.employeeId]={id:r.employeeId,name:r.employeeName,manager:r.managerName,totalHrs:0,processes:[]};
            workersMap[r.employeeId].totalHrs+=r.totalHrs; workersMap[r.employeeId].processes.push(pn.processLabel); totalHrs+=r.totalHrs;
        });
    });
    const workers=Object.values(workersMap).sort((a,b)=>b.totalHrs-a.totalHrs);
    processBreakdowns.sort((a,b)=>b.totalHrs!==a.totalHrs?b.totalHrs-a.totalHrs:a.processLabel.localeCompare(b.processLabel));
    return { workers, associates:workers.length, totalHrs, processBreakdowns };
}

function getGroupedCategoryData() {
    const categories=[]; let grandAssociates=0, grandHours=0;
    CATEGORY_TREE.forEach(function(category){
        if (category.flat) {
            const fd=collectWorkersForProcessKeys(category.processKeys);
            grandAssociates+=fd.associates; grandHours+=fd.totalHrs;
            categories.push({ name:category.name, associates:fd.associates, totalHrs:fd.totalHrs, workers:fd.workers, flat:true, processBreakdowns:fd.processBreakdowns, children:[] });
            return;
        }
        const cwm={}; let catHours=0; const children=[];
        category.children.forEach(function(sc){
            const sd=collectWorkersForProcessKeys(sc.processKeys);
            sd.workers.forEach(function(worker){
                if (!cwm[worker.id]) cwm[worker.id]={id:worker.id,name:worker.name,manager:worker.manager,totalHrs:0,processes:[]};
                cwm[worker.id].totalHrs+=worker.totalHrs; cwm[worker.id].processes=cwm[worker.id].processes.concat(worker.processes);
            });
            catHours+=sd.totalHrs;
            children.push({ name:sc.name, processKeys:sc.processKeys.slice(), associates:sd.associates, totalHrs:sd.totalHrs, workers:sd.workers, processBreakdowns:sd.processBreakdowns });
        });
        const catWorkers=Object.values(cwm).sort((a,b)=>b.totalHrs-a.totalHrs);
        grandAssociates+=catWorkers.length; grandHours+=catHours;
        categories.push({ name:category.name, associates:catWorkers.length, totalHrs:catHours, workers:catWorkers, flat:false, children });
    });
    return { categories, totalAssociates:grandAssociates, totalHrs:grandHours };
}


function populateShiftSelect() {
    const shiftSelect = document.getElementById('lhqv-shift-select');
    if (!shiftSelect) return;
    shiftSelect.innerHTML = '';
    const shifts = getAvailableShifts();
    if (siteUsesShiftSelector()) {
        const autoOpt = document.createElement('option');
        autoOpt.value = ''; autoOpt.textContent = 'Auto Shift';
        shiftSelect.appendChild(autoOpt);
        Object.keys(shifts).forEach(function(sk){
            const opt=document.createElement('option'); opt.value=sk; opt.textContent=shifts[sk].label; shiftSelect.appendChild(opt);
        });
        shiftSelect.value = selectedShift || '';
    } else {
        Object.keys(shifts).forEach(function(sk){
            const opt=document.createElement('option'); opt.value=sk; opt.textContent=shifts[sk].label; shiftSelect.appendChild(opt);
        });
        shiftSelect.value = getDefaultShiftForSite();
    }
}

function setDashboardOpen(open) {
    const overlay=document.getElementById('lhqv-overlay');
    const launcher=document.getElementById('lhqv-launcher');
    if (!overlay||!launcher) return;
    isDashboardOpen=open;
    overlay.classList.toggle('open',open);
    launcher.style.display=open?'none':'flex';
    document.body.style.overflow=open?'hidden':'';
}

function escapeCSV(value) {
    const str=String(value??'');
    if (str.includes('"')||str.includes(',')||str.includes('\n')) return '"'+str.replace(/"/g,'""')+'"';
    return str;
}

function buildCSVRows() {
    const rows=[]; const grouped=getGroupedCategoryData();
    grouped.categories.forEach(function(category){
        if (category.flat) {
            category.processBreakdowns.forEach(function(pi){
                pi.breakouts.forEach(function(br){
                    br.workers.forEach(function(w){
                        rows.push({ site:selectedSite, viewMode:selectedViewMode, dateOrWeek:selectedViewMode==='WEEK'?getWeekLabelText():(selectedDate||todayStr()), operationalWindow:getShiftWindow(getEffectiveShift()).label, category:category.name, subCategory:'', process:pi.processLabel, breakout:br.name, employeeId:w.employeeId, employeeName:w.employeeName, manager:w.managerName||'', totalHours:w.totalHrs.toFixed(2) });
                    });
                });
            });
        } else {
            category.children.forEach(function(child){
                child.processBreakdowns.forEach(function(pi){
                    pi.breakouts.forEach(function(br){
                        br.workers.forEach(function(w){
                            rows.push({ site:selectedSite, viewMode:selectedViewMode, dateOrWeek:selectedViewMode==='WEEK'?getWeekLabelText():(selectedDate||todayStr()), operationalWindow:getShiftWindow(getEffectiveShift()).label, category:category.name, subCategory:child.name, process:pi.processLabel, breakout:br.name, employeeId:w.employeeId, employeeName:w.employeeName, manager:w.managerName||'', totalHours:w.totalHrs.toFixed(2) });
                        });
                    });
                });
            });
        }
    });
    return rows;
}

function exportCSV() {
    const rows=buildCSVRows();
    if (!rows.length) { updateStatus('No data to export.','error'); return; }
    const header=['Site','View Mode','Date/Week','Operational Window','Category','Sub Category','Process','Breakout','Employee ID','Employee Name','Manager','Total Hours'];
    let csv=header.join(',')+'\n';
    rows.forEach(function(row){
        csv+=[escapeCSV(row.site),escapeCSV(row.viewMode),escapeCSV(row.dateOrWeek),escapeCSV(row.operationalWindow),escapeCSV(row.category),escapeCSV(row.subCategory),escapeCSV(row.process),escapeCSV(row.breakout),escapeCSV(row.employeeId),escapeCSV(row.employeeName),escapeCSV(row.manager),escapeCSV(row.totalHours)].join(',')+'\n';
    });
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); const now=new Date();
    a.href=url;
    a.download=[selectedSite,'labour_hours',selectedViewMode.toLowerCase(),selectedViewMode==='WEEK'?('week_'+getWeekNumber(selectedDate?new Date(selectedDate+'T12:00:00'):getOperationalNowBaseDate())):(selectedDate||todayStr()),now.getFullYear()+pad2(now.getMonth()+1)+pad2(now.getDate()),pad2(now.getHours())+pad2(now.getMinutes())].join('_')+'.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    updateStatus('CSV exported.','ok');
}

function updateStatus(msg, state) {
    const el=document.getElementById('lhqv-status');
    if (!el) return;
    el.textContent=msg;
    if (state==='loading'){ el.style.color='#93c5fd'; el.style.fontStyle='italic'; }
    else if (state==='ok'){ el.style.color=currentTheme==='light'?'#16a34a':'#86efac'; el.style.fontStyle='normal'; }
    else if (state==='error'){ el.style.color='#fca5a5'; el.style.fontStyle='normal'; }
    else { el.style.color='#93c5fd'; el.style.fontStyle='normal'; }
}

function autoRefresh() {
    nextRefreshAt=Date.now()+refreshInterval;
    const currentShift=inferShift();
    if (siteUsesShiftSelector()&&!selectedShift&&lastAutoShift&&lastAutoShift!==currentShift) {
        selectedDate=null;
        const dp=document.getElementById('lhqv-date-picker');
        if (dp){ dp.value=todayStr(); dp.max=todayStr(); }
        updateHeaderBadges();
    }
    lastAutoShift=currentShift;
    const dp=document.getElementById('lhqv-date-picker');
    if (dp) dp.max=todayStr();
    refreshData();
}

function updateHeaderBadges() {
    const siteBadge=document.getElementById('lhqv-site-badge');
    const shiftBadge=document.getElementById('lhqv-shift-badge');
    const weekBadge=document.getElementById('lhqv-week-badge');
    const shiftSelect=document.getElementById('lhqv-shift-select');
    const siteSelect=document.getElementById('lhqv-site-select');
    if (siteBadge) siteBadge.textContent=selectedSite;
    if (siteSelect) siteSelect.value=selectedSite;
    if (shiftBadge) {
        const es=getEffectiveShift();
        shiftBadge.textContent=es==='DAY'?'DAY':(es==='NIGHT'?'NIGHT':'EOS');
        shiftBadge.className='lhqv-badge '+(es==='DAY'?'day':'night');
    }
    if (weekBadge) {
        if (selectedViewMode==='WEEK') { weekBadge.textContent=getWeekLabelText(); }
        else { weekBadge.textContent='Week '+getWeekNumber(selectedDate?new Date(selectedDate+'T12:00:00'):getOperationalNowBaseDate()); }
    }
    if (shiftSelect) {
        shiftSelect.disabled=!siteUsesShiftSelector()||selectedViewMode==='WEEK';
        shiftSelect.style.opacity=shiftSelect.disabled?'0.45':'1';
    }
}


function renderCards(grouped) {
    const totalHrsEl=document.getElementById('lhqv-total-hrs');
    const totalAssEl=document.getElementById('lhqv-total-associates');
    const topCatEl=document.getElementById('lhqv-top-category');
    const topCatSubEl=document.getElementById('lhqv-top-category-sub');
    const barWrap=document.getElementById('lhqv-bar-wrap');
    if (!totalHrsEl||!totalAssEl||!topCatEl||!topCatSubEl||!barWrap) return;
    totalHrsEl.textContent=grouped.totalHrs.toFixed(2);
    totalAssEl.textContent=grouped.totalAssociates;
    const topCat=grouped.categories.slice().sort((a,b)=>b.totalHrs-a.totalHrs)[0];
    if (topCat&&topCat.totalHrs>0){ topCatEl.textContent=topCat.name; topCatSubEl.textContent=topCat.totalHrs.toFixed(2)+' hrs \u00b7 '+topCat.associates+' associates'; }
    else { topCatEl.textContent='-'; topCatSubEl.textContent='Waiting for data'; }
    const palette=['#22c55e','#38bdf8','#f59e0b','#a78bfa','#ef4444','#14b8a6'];
    barWrap.innerHTML='';
    grouped.categories.forEach(function(cat,index){
        if (grouped.totalHrs<=0||cat.totalHrs<=0) return;
        const seg=document.createElement('div');
        seg.className='lhqv-bar-segment';
        seg.style.width=((cat.totalHrs/grouped.totalHrs)*100).toFixed(2)+'%';
        seg.style.background=palette[index%palette.length];
        seg.title=cat.name+': '+cat.totalHrs.toFixed(2)+' hrs';
        barWrap.appendChild(seg);
    });
}

// ── WEEK TABLE VIEW ──────────────────────────────────────────────────────────
function renderWeekTable() {
    const wrap = document.getElementById('lhqv-table-wrap');
    if (!wrap) return;
    const weekDates = getWeekDatesForSelectedContext();
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const grouped = getGroupedCategoryData();
    renderCards(grouped);

    // Build per-day totals by category
    // We store results keyed by dateStr
    // weekRates[dateStr][processLabel] already accumulated in rates[] but we need per-day
    // Since rates[] is accumulated across all days in WEEK mode, we need the raw per-day breakdown
    // We'll pull from the already-accumulated rates keyed by date via weekBreakdown
    // (weekBreakdown populated during refreshData into rates using dateStr prefix)
    // For week table we show: Category | Mon | Tue | Wed | Thu | Fri | Sat | Sun | Total

    let html = '<table id="lhqv-week-table">';
    html += '<thead><tr><th>Category</th>';
    weekDates.forEach(function(d,i){
        const iso=fmtISODate(d);
        const isToday=iso===todayStr();
        html += '<th class="'+(isToday?'lhqv-today-col':'')+'">'+dayNames[d.getDay()]+'<br><span class="lhqv-week-date">'+iso.slice(5)+'</span></th>';
    });
    html += '<th class="lhqv-week-total-col">Total</th></tr></thead><tbody>';

    // For each category row
    grouped.categories.forEach(function(cat){
        // Category header row
        const catExpanded = !!categoryState['wk_'+cat.name];
        html += '<tr class="lhqv-wk-cat-row" data-expand-key="wk_'+cat.name+'" style="cursor:pointer;">';
        html += '<td><span class="lhqv-chevron">'+(catExpanded?'&#9660;':'&#9654;')+'</span> <strong>'+cat.name+'</strong></td>';
        let catTotal = 0;
        weekDates.forEach(function(d){
            const hrs = getHoursForCategoryAndDate(cat, fmtISODate(d));
            catTotal += hrs;
            const isToday = fmtISODate(d)===todayStr();
            html += '<td class="lhqv-week-cell'+(isToday?' lhqv-today-col':'')+'">'+( hrs>0 ? '<span class="lhqv-wk-hrs">'+hrs.toFixed(1)+'</span>' : '<span class="lhqv-wk-zero">-</span>' )+'</td>';
        });
        html += '<td class="lhqv-week-cell lhqv-week-total-col"><strong>'+(catTotal>0?catTotal.toFixed(1):'-')+'</strong></td>';
        html += '</tr>';

        // Sub rows if expanded
        if (catExpanded) {
            const subItems = cat.flat ? cat.processBreakdowns : cat.children;
            (subItems||[]).forEach(function(sub){
                const subName = sub.processLabel || sub.name;
                html += '<tr class="lhqv-wk-sub-row">';
                html += '<td style="padding-left:28px;">&nbsp;&nbsp;'+subName+'</td>';
                let subTotal=0;
                weekDates.forEach(function(d){
                    const hrs = cat.flat
                        ? getHoursForProcessAndDate(sub.processKey, fmtISODate(d))
                        : getHoursForSubCatAndDate(sub, fmtISODate(d));
                    subTotal+=hrs;
                    const isToday=fmtISODate(d)===todayStr();
                    html += '<td class="lhqv-week-cell'+(isToday?' lhqv-today-col':'')+'">'+( hrs>0 ? '<span class="lhqv-wk-hrs">'+hrs.toFixed(1)+'</span>' : '<span class="lhqv-wk-zero">-</span>' )+'</td>';
                });
                html += '<td class="lhqv-week-cell lhqv-week-total-col">'+(subTotal>0?subTotal.toFixed(1):'-')+'</td>';
                html += '</tr>';
            });
        }
    });

    // Grand total row
    html += '<tr class="lhqv-wk-total-row"><td><strong>TOTAL</strong></td>';
    let grandTotal=0;
    weekDates.forEach(function(d){
        let dayTotal=0;
        grouped.categories.forEach(function(cat){ dayTotal+=getHoursForCategoryAndDate(cat,fmtISODate(d)); });
        grandTotal+=dayTotal;
        const isToday=fmtISODate(d)===todayStr();
        html += '<td class="lhqv-week-cell'+(isToday?' lhqv-today-col':'')+'"><strong>'+(dayTotal>0?dayTotal.toFixed(1):'-')+'</strong></td>';
    });
    html += '<td class="lhqv-week-cell lhqv-week-total-col"><strong>'+(grandTotal>0?grandTotal.toFixed(1):'-')+'</strong></td></tr>';
    html += '</tbody></table>';

    wrap.innerHTML = html;

    // Attach expand listeners
    wrap.querySelectorAll('[data-expand-key]').forEach(function(row){
        row.addEventListener('click', function(){
            const key=this.getAttribute('data-expand-key');
            categoryState[key]=!categoryState[key];
            renderTable();
        });
    });

    updateSummary(grouped,'');
}

function getHoursForCategoryAndDate(cat, dateStr) {
    let total=0;
    if (cat.flat) {
        cat.processBreakdowns.forEach(function(pb){ total+=getHoursForProcessAndDate(pb.processKey,dateStr); });
    } else {
        cat.children.forEach(function(child){ total+=getHoursForSubCatAndDate(child,dateStr); });
    }
    return total;
}
function getHoursForSubCatAndDate(subCat, dateStr) {
    let total=0;
    (subCat.processKeys||[]).forEach(function(pk){ total+=getHoursForProcessAndDate(pk,dateStr); });
    return total;
}
function getHoursForProcessAndDate(procKey, dateStr) {
    // In week view, rates are accumulated across all days combined.
    // We need per-day data — stored in weekDayRates[dateStr][procKey]
    if (!window._lhqvWeekDayRates) return 0;
    const dayData=window._lhqvWeekDayRates[dateStr];
    if (!dayData||!dayData[procKey]) return 0;
    return Object.values(dayData[procKey].workers||{}).reduce(function(s,w){ return s+w.totalHrs; },0);
}


// Override aggregateData to also store per-day data for week table
function aggregateDataWithDay(productivityList, processLabel, processConfig, dateStr) {
    aggregateData(productivityList, processLabel, processConfig);
    // Also store in per-day store
    if (!window._lhqvWeekDayRates) window._lhqvWeekDayRates={};
    if (!window._lhqvWeekDayRates[dateStr]) window._lhqvWeekDayRates[dateStr]={};
    const dayStore=window._lhqvWeekDayRates[dateStr];
    if (!dayStore[processLabel]) dayStore[processLabel]={ workers:{}, breakouts:{} };
    const store=dayStore[processLabel];
    const filter=processConfig&&processConfig.filter?processConfig.filter:null;
    for (let i=0;i<productivityList.length;i++) {
        const entry=productivityList[i]; const pa=entry.processAttributes||{};
        if (filter&&!valueMatchesFilter(pa,filter)) continue;
        const trackingType=pa.laborTrackingType||'';
        const associates=entry.associateProductivityList||[];
        const bv=getBreakoutValue(pa,processConfig);
        if (!store.breakouts[bv]) store.breakouts[bv]={ name:bv, workers:{} };
        const seen={};
        for (let j=0;j<associates.length;j++) {
            const a=associates[j]; const empId=a.employeeId;
            if (!empId||seen[empId]) continue; seen[empId]=true;
            const hours=Number(a.timeMillis||a.timeSeconds||0)/3600;
            const name=a.employeeName||'', mgr=a.managerName||'';
            if (!store.workers[empId]) store.workers[empId]={ employeeId:empId, employeeName:name, managerName:mgr, totalDirect:0, totalIndirect:0, totalHrs:0 };
            const wr=store.workers[empId];
            if (trackingType==='direct') wr.totalDirect+=hours; else wr.totalIndirect+=hours;
            wr.totalHrs=wr.totalDirect+wr.totalIndirect;
        }
    }
}

// Patch loadProcess to use aggregateDataWithDay when in week mode
function loadProcessWeek(processLabel, processConfig, onDone, thisGen, forcedDateStr, forcedShiftKey) {
    const url = buildPPAUrl(processConfig, forcedDateStr, forcedShiftKey);
    GM_xmlhttpRequest({
        method:'GET', url:url, timeout:15000,
        onload: function(r){
            if (thisGen!==refreshGeneration) return;
            if (r.status>=200&&r.status<300){
                const list=extractProductivityList(r.responseText);
                if (list) aggregateDataWithDay(list, processLabel, processConfig, forcedDateStr);
                onDone(processLabel,!!list);
            } else onDone(processLabel,false);
        },
        onerror:   function(){ onDone(processLabel,false); },
        ontimeout: function(){ onDone(processLabel,false); }
    });
}

// Updated refreshData that uses week-aware loader
function refreshData() {
    const cacheKey = getCacheKey();
    if (isHistorical()&&dataCache[cacheKey]) {
        for (const key in rates) delete rates[key];
        const cached=dataCache[cacheKey];
        for (const key in cached) rates[key]=JSON.parse(JSON.stringify(cached[key]));
        lastRefresh=new Date(); updateHeaderBadges(); renderTable(); resetRefreshTimer();
        updateStatus('Loaded from cache \u00b7 '+selectedSite,'ok'); return;
    }
    refreshGeneration++;
    const thisGen=refreshGeneration;
    for (const key in rates) delete rates[key];
    window._lhqvWeekDayRates={};
    const entries=Object.entries(TRACKED_PROCESSES);
    const failedProcesses=[]; let workItems=[];
    if (selectedViewMode==='DAY') {
        totalToLoad=entries.length;
        const fds=selectedDate||null, fsk=getEffectiveShift();
        entries.forEach(function(e){ workItems.push({label:e[0],config:e[1],dateStr:fds,shiftKey:fsk,isWeek:false}); });
    } else {
        const weekDates=getWeekDatesForSelectedContext();
        const shiftsToLoad=(selectedSite==='LCY8')?Object.keys(getAvailableShifts()):[getEffectiveShift()];
        totalToLoad=entries.length*weekDates.length*shiftsToLoad.length;
        weekDates.forEach(function(dateObj){
            const dateStr=fmtISODate(dateObj);
            shiftsToLoad.forEach(function(shiftKey){
                entries.forEach(function(e){ workItems.push({label:e[0],config:e[1],dateStr:dateStr,shiftKey:shiftKey,isWeek:true}); });
            });
        });
    }
    loadedCount=0;
    updateStatus('Loading 0/'+totalToLoad+'...','loading');
    function onProcessDone(lbl,success) {
        if (thisGen!==refreshGeneration) return;
        if (!success) failedProcesses.push(lbl);
        loadedCount++;
        updateStatus('Loading '+loadedCount+'/'+totalToLoad+'...','loading');
        renderTable();
        if (loadedCount>=totalToLoad) {
            lastRefresh=new Date(); updateHeaderBadges();
            let msg;
            if (selectedViewMode==='WEEK'){ msg='Loaded \u00b7 '+selectedSite+' \u00b7 '+getWeekLabelText()+((selectedSite==='LCY8')?' \u00b7 Day+Night':'')+' \u00b7 '+lastRefresh.toLocaleTimeString(); }
            else { msg='Loaded \u00b7 '+selectedSite+' \u00b7 '+(selectedDate||'Today')+' \u00b7 '+getShiftWindow(getEffectiveShift()).label+' \u00b7 '+lastRefresh.toLocaleTimeString(); }
            if (failedProcesses.length>0) msg+=' \u00b7 '+failedProcesses.length+' failed';
            updateStatus(msg,failedProcesses.length>0?'error':'ok');
            if (isHistorical()){ dataCache[cacheKey]={}; for (const k in rates) dataCache[cacheKey][k]=JSON.parse(JSON.stringify(rates[k])); }
        }
    }
    function launchBatch(startIndex) {
        if (thisGen!==refreshGeneration) return;
        const end=Math.min(startIndex+BATCH_SIZE,workItems.length);
        for (let i=startIndex;i<end;i++){
            const item=workItems[i];
            if (item.isWeek) loadProcessWeek(item.label,item.config,onProcessDone,thisGen,item.dateStr,item.shiftKey);
            else loadProcess(item.label,item.config,onProcessDone,thisGen,item.dateStr,item.shiftKey);
        }
        if (end<workItems.length) setTimeout(function(){ launchBatch(end); },BATCH_DELAY);
    }
    launchBatch(0); resetRefreshTimer();
}


function renderProcessBreakdowns(tbody, processBreakdowns, searchTerm, parentKeyBase) {
    processBreakdowns.forEach(function(pi){
        let visibleBreakouts=pi.breakouts;
        if (searchTerm) {
            visibleBreakouts=pi.breakouts.map(function(br){
                const fw=br.workers.filter(w=>(w.employeeName||'').toLowerCase().includes(searchTerm)||(w.managerName||'').toLowerCase().includes(searchTerm));
                return Object.assign({},br,{workers:fw,associates:fw.length,totalHrs:fw.reduce((s,w)=>s+w.totalHrs,0)});
            }).filter(b=>b.workers.length>0);
        }
        if (!visibleBreakouts.length) return;
        const processKey=parentKeyBase+'||PROC||'+pi.processKey;
        const processExpanded=!!processState[processKey];
        const pa=visibleBreakouts.reduce((s,b)=>s+b.associates,0);
        const ph=visibleBreakouts.reduce((s,b)=>s+b.totalHrs,0);
        const processRow=document.createElement('tr');
        processRow.className='lhqv-process-row';
        processRow.innerHTML='<td><div class="lhqv-group-title lhqv-process-title"><span class="lhqv-chevron">'+(processExpanded?'&#9660;':'&#9654;')+'</span><span>'+pi.processLabel+'</span></div></td><td><span class="lhqv-group-meta">EOS Process</span></td><td>'+pa+' associate'+(pa===1?'':'s')+'</td><td class="lhqv-hours">'+ph.toFixed(2)+'</td>';
        processRow.addEventListener('click',function(e){ e.stopPropagation(); processState[processKey]=!processExpanded; renderTable(); });
        tbody.appendChild(processRow);
        if (processExpanded) {
            visibleBreakouts.forEach(function(br){
                const bKey=processKey+'||BR||'+br.name;
                const bExpanded=!!breakoutState[bKey];
                const bRow=document.createElement('tr'); bRow.className='lhqv-breakout-row';
                bRow.innerHTML='<td><div class="lhqv-group-title lhqv-breakout-title"><span class="lhqv-chevron">'+(bExpanded?'&#9660;':'&#9654;')+'</span><span>'+br.name+'</span></div></td><td><span class="lhqv-group-meta">JOB_ROLE</span></td><td>'+br.associates+' associate'+(br.associates===1?'':'s')+'</td><td class="lhqv-hours">'+br.totalHrs.toFixed(2)+'</td>';
                bRow.addEventListener('click',function(e){ e.stopPropagation(); breakoutState[bKey]=!bExpanded; renderTable(); });
                tbody.appendChild(bRow);
                if (bExpanded) {
                    br.workers.forEach(function(worker){
                        const row=document.createElement('tr');
                        row.innerHTML='<td class="lhqv-worker-name">'+worker.employeeName+'<div class="lhqv-worker-sub">ID: '+worker.employeeId+'</div></td><td>'+(worker.managerName||'-')+'</td><td>'+pi.processLabel+'</td><td class="lhqv-hours">'+worker.totalHrs.toFixed(2)+'</td>';
                        tbody.appendChild(row);
                    });
                }
            });
        }
    });
}

function renderTable() {
    if (selectedViewMode==='WEEK') { renderWeekTable(); return; }
    const tbody=document.getElementById('lhqv-table-body');
    if (!tbody) return;
    const searchInput=document.getElementById('lhqv-search');
    const searchTerm=(searchInput?searchInput.value:'').toLowerCase().trim();
    const grouped=getGroupedCategoryData();
    renderCards(grouped);
    tbody.innerHTML='';
    if (!grouped.categories.length) {
        tbody.innerHTML='<tr><td colspan="4" style="text-align:center;padding:24px;">No data yet</td></tr>';
        updateSummary(grouped,searchTerm); return;
    }
    let shownAny=false;
    grouped.categories.forEach(function(category){
        if (category.flat) {
            let vw=category.workers, vp=category.processBreakdowns;
            if (searchTerm) {
                vw=category.workers.filter(w=>(w.name||'').toLowerCase().includes(searchTerm)||(w.manager||'').toLowerCase().includes(searchTerm));
                vp=category.processBreakdowns.map(function(proc){
                    const fb=proc.breakouts.map(function(br){ const fw=br.workers.filter(w=>(w.employeeName||'').toLowerCase().includes(searchTerm)||(w.managerName||'').toLowerCase().includes(searchTerm)); return Object.assign({},br,{workers:fw,associates:fw.length,totalHrs:fw.reduce((s,w)=>s+w.totalHrs,0)}); }).filter(br=>br.workers.length>0);
                    return Object.assign({},proc,{breakouts:fb});
                }).filter(proc=>proc.breakouts.length>0);
            }
            if (!searchTerm||vw.length>0||vp.length>0) {
                shownAny=true;
                const catExpanded=!!categoryState[category.name];
                const assocCount=searchTerm?vw.length:category.associates;
                const hours=searchTerm?vw.reduce((s,w)=>s+w.totalHrs,0):category.totalHrs;
                const catRow=document.createElement('tr'); catRow.className='lhqv-category-row';
                catRow.innerHTML='<td><div class="lhqv-group-title lhqv-category-title"><span class="lhqv-chevron">'+(catExpanded?'&#9660;':'&#9654;')+'</span><span>'+category.name+'</span></div></td><td><span class="lhqv-group-meta">Combined</span></td><td>'+assocCount+' associate'+(assocCount===1?'':'s')+'</td><td class="lhqv-hours">'+hours.toFixed(2)+'</td>';
                catRow.addEventListener('click',function(){ categoryState[category.name]=!catExpanded; renderTable(); });
                tbody.appendChild(catRow);
                if (catExpanded) renderProcessBreakdowns(tbody,vp,searchTerm,category.name);
            }
            return;
        }
        let vc=category.children;
        if (searchTerm) {
            vc=category.children.map(function(child){
                const fw=child.workers.filter(w=>(w.name||'').toLowerCase().includes(searchTerm)||(w.manager||'').toLowerCase().includes(searchTerm));
                const fp=child.processBreakdowns.map(function(proc){ const fb=proc.breakouts.map(function(br){ const fwb=br.workers.filter(w=>(w.employeeName||'').toLowerCase().includes(searchTerm)||(w.managerName||'').toLowerCase().includes(searchTerm)); return Object.assign({},br,{workers:fwb,associates:fwb.length,totalHrs:fwb.reduce((s,w)=>s+w.totalHrs,0)}); }).filter(br=>br.workers.length>0); return Object.assign({},proc,{breakouts:fb}); }).filter(proc=>proc.breakouts.length>0);
                return Object.assign({},child,{workers:fw,associates:fw.length,totalHrs:fw.reduce((s,w)=>s+w.totalHrs,0),processBreakdowns:fp});
            }).filter(child=>child.workers.length>0||child.processBreakdowns.length>0);
            if (!vc.length) return;
        }
        shownAny=true;
        const catExpanded=!!categoryState[category.name];
        const cac=vc.reduce((s,c)=>s+c.associates,0);
        const ch=vc.reduce((s,c)=>s+c.totalHrs,0);
        const catRow=document.createElement('tr'); catRow.className='lhqv-category-row';
        catRow.innerHTML='<td><div class="lhqv-group-title lhqv-category-title"><span class="lhqv-chevron">'+(catExpanded?'&#9660;':'&#9654;')+'</span><span>'+category.name+'</span></div></td><td><span class="lhqv-group-meta">Category Total</span></td><td>'+cac+' associate'+(cac===1?'':'s')+'</td><td class="lhqv-hours">'+ch.toFixed(2)+'</td>';
        catRow.addEventListener('click',function(){ categoryState[category.name]=!catExpanded; renderTable(); });
        tbody.appendChild(catRow);
        if (catExpanded) {
            vc.forEach(function(child){
                const subKey=category.name+'||'+child.name;
                const subExpanded=!!subCategoryState[subKey];
                const subRow=document.createElement('tr'); subRow.className='lhqv-subcategory-row';
                subRow.innerHTML='<td><div class="lhqv-group-title lhqv-subcategory-title"><span class="lhqv-chevron">'+(subExpanded?'&#9660;':'&#9654;')+'</span><span>'+child.name+'</span></div></td><td><span class="lhqv-group-meta">'+child.processKeys.join(', ')+'</span></td><td>'+child.associates+' associate'+(child.associates===1?'':'s')+'</td><td class="lhqv-hours">'+child.totalHrs.toFixed(2)+'</td>';
                subRow.addEventListener('click',function(e){ e.stopPropagation(); subCategoryState[subKey]=!subExpanded; renderTable(); });
                tbody.appendChild(subRow);
                if (subExpanded) renderProcessBreakdowns(tbody,child.processBreakdowns,searchTerm,subKey);
            });
        }
    });
    if (!shownAny) tbody.innerHTML='<tr><td colspan="4" style="text-align:center;padding:24px;">No matches found</td></tr>';
    updateSummary(grouped,searchTerm);
}

function updateSummary(grouped, searchTerm) {
    const bar=document.getElementById('lhqv-summary-bar');
    if (!bar) return;
    const oc=Object.keys(categoryState).filter(k=>categoryState[k]).length;
    const os=Object.keys(subCategoryState).filter(k=>subCategoryState[k]).length;
    const op=Object.keys(processState).filter(k=>processState[k]).length;
    const ob=Object.keys(breakoutState).filter(k=>breakoutState[k]).length;
    const parts=[
        { label:selectedSite, color:'#d8b4fe' },
        { label:grouped.totalAssociates+' associates', color:'#86efac' },
        { label:grouped.totalHrs.toFixed(2)+' hrs total', color:'#7dd3fc' },
        { label:oc+' cats \u00b7 '+os+' subs \u00b7 '+op+' procs \u00b7 '+ob+' breakouts open', color:'#94a3b8' }
    ];
    if (selectedViewMode==='WEEK') parts.push({ label:getWeekLabelText(), color:'#86efac' });
    if (searchTerm) parts.push({ label:'\u{1F50D} "'+searchTerm+'"', color:'#fde68a' });
    bar.innerHTML=parts.map(p=>'<span style="color:'+p.color+';margin-right:16px;">'+p.label+'</span>').join('<span style="color:#334155;margin-right:16px;">|</span>');
}


function getThemeCSS() {
return `
/* ── THEME VARIABLES ── */
#lhqv-overlay.theme-dark {
    --bg-overlay:rgba(2,6,23,0.78);
    --bg-shell:linear-gradient(160deg,rgba(15,23,42,0.98),rgba(2,6,23,0.99));
    --bg-header:rgba(15,23,42,0.92);
    --bg-cards:rgba(2,6,23,0.5);
    --bg-card:rgba(15,23,42,0.9);
    --bg-search-wrap:rgba(2,6,23,0.45);
    --bg-search:rgba(15,23,42,0.92);
    --bg-table-wrap:transparent;
    --bg-td:rgba(15,23,42,0.75);
    --bg-td-hover:rgba(30,41,59,0.95);
    --bg-thead:rgba(2,6,23,0.98);
    --bg-status:rgba(2,6,23,0.6);
    --bg-summary:rgba(2,6,23,0.96);
    --bg-ctrl-select:rgba(15,23,42,0.88);
    --color-text:#e5eefc;
    --color-text-dim:#94a3b8;
    --color-text-muted:#64748b;
    --color-text-head:#475569;
    --color-title:#f8fafc;
    --color-hrs:#38bdf8;
    --color-border:rgba(148,163,184,0.15);
    --color-border-ctrl:rgba(96,165,250,0.3);
    --color-ctrl-text:#e2e8f0;
    --color-cat-bg:rgba(34,197,94,0.10);
    --color-cat-hover:rgba(34,197,94,0.18);
    --color-sub-bg:rgba(14,165,233,0.09);
    --color-sub-hover:rgba(14,165,233,0.16);
    --color-proc-bg:rgba(168,85,247,0.09);
    --color-proc-hover:rgba(168,85,247,0.16);
    --color-br-bg:rgba(245,158,11,0.09);
    --color-br-hover:rgba(245,158,11,0.16);
    --color-wk-head:#1e293b;
    --color-wk-head-text:#94a3b8;
    --color-wk-cat:#1e3a5f;
    --color-wk-sub:rgba(15,23,42,0.85);
    --color-wk-total:#0f2744;
    --color-wk-cell-text:#e2e8f0;
    --color-wk-today:#1e3a2f;
    --color-wk-zero:#334155;
    --color-wk-border:rgba(148,163,184,0.1);
}
#lhqv-overlay.theme-light {
    --bg-overlay:rgba(100,116,139,0.5);
    --bg-shell:linear-gradient(160deg,#f8fafc,#f1f5f9);
    --bg-header:#ffffff;
    --bg-cards:#f1f5f9;
    --bg-card:#ffffff;
    --bg-search-wrap:#f8fafc;
    --bg-search:#ffffff;
    --bg-table-wrap:#f8fafc;
    --bg-td:#ffffff;
    --bg-td-hover:#f1f5f9;
    --bg-thead:#f8fafc;
    --bg-status:#f1f5f9;
    --bg-summary:#f8fafc;
    --bg-ctrl-select:#ffffff;
    --color-text:#1e293b;
    --color-text-dim:#475569;
    --color-text-muted:#94a3b8;
    --color-text-head:#64748b;
    --color-title:#0f172a;
    --color-hrs:#2563eb;
    --color-border:rgba(148,163,184,0.3);
    --color-border-ctrl:rgba(37,99,235,0.35);
    --color-ctrl-text:#1e293b;
    --color-cat-bg:rgba(34,197,94,0.08);
    --color-cat-hover:rgba(34,197,94,0.15);
    --color-sub-bg:rgba(14,165,233,0.07);
    --color-sub-hover:rgba(14,165,233,0.13);
    --color-proc-bg:rgba(168,85,247,0.07);
    --color-proc-hover:rgba(168,85,247,0.13);
    --color-br-bg:rgba(245,158,11,0.07);
    --color-br-hover:rgba(245,158,11,0.13);
    --color-wk-head:#e2e8f0;
    --color-wk-head-text:#475569;
    --color-wk-cat:#dbeafe;
    --color-wk-sub:#f8fafc;
    --color-wk-total:#bfdbfe;
    --color-wk-cell-text:#1e293b;
    --color-wk-today:#dcfce7;
    --color-wk-zero:#cbd5e1;
    --color-wk-border:rgba(148,163,184,0.25);
}

/* ── LAUNCHER ── */
#lhqv-launcher {
    position:fixed; top:16px; right:16px; width:52px; height:52px;
    border:none; border-radius:14px;
    background:linear-gradient(145deg,#38bdf8,#2563eb);
    color:#fff; font-size:22px; cursor:pointer; z-index:999999;
    box-shadow:0 8px 24px rgba(37,99,235,0.45);
    display:flex; align-items:center; justify-content:center;
    transition:transform 0.15s,box-shadow 0.15s;
}
#lhqv-launcher:hover { transform:scale(1.08); box-shadow:0 12px 32px rgba(37,99,235,0.6); }

/* ── OVERLAY ── */
#lhqv-overlay {
    position:fixed; inset:0;
    background:var(--bg-overlay); backdrop-filter:blur(12px);
    z-index:999998; display:none; padding:10px; box-sizing:border-box;
}
#lhqv-overlay.open { display:flex; }

/* ── SHELL ── */
#lhqv-shell {
    width:100%; height:100%; display:flex; flex-direction:column;
    background:var(--bg-shell);
    color:var(--color-text); font-family:Inter,system-ui,Arial,sans-serif;
    border:1px solid var(--color-border); border-radius:20px;
    box-shadow:0 24px 60px rgba(0,0,0,0.35); overflow:hidden;
}

/* ── HEADER ── */
#lhqv-header {
    padding:14px 18px 12px; border-bottom:1px solid var(--color-border);
    background:var(--bg-header); flex-shrink:0;
}
#lhqv-header-top { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-bottom:12px; }
#lhqv-title { margin:0; font-size:clamp(16px,1.8vw,22px); font-weight:800; color:var(--color-title); display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
#lhqv-header-badges { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
#lhqv-controls { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
#lhqv-controls-left { display:flex; gap:8px; flex-wrap:wrap; flex:1; }
#lhqv-controls-right { display:flex; gap:6px; flex-wrap:wrap; }

#lhqv-controls select, #lhqv-controls input[type="date"] {
    height:36px; background:var(--bg-ctrl-select); color:var(--color-ctrl-text);
    border:1px solid var(--color-border-ctrl); border-radius:10px;
    padding:0 10px; font-size:12px; box-sizing:border-box; cursor:pointer;
    transition:border-color 0.15s,background 0.15s;
}
#lhqv-controls select:hover, #lhqv-controls input[type="date"]:hover { border-color:rgba(56,189,248,0.65); }

/* ── BUTTONS ── */
.lhqv-btn { height:36px; padding:0 14px; border:none; border-radius:10px; font-size:12px; font-weight:700; cursor:pointer; white-space:nowrap; transition:opacity 0.15s,transform 0.1s; }
.lhqv-btn:hover { opacity:0.85; transform:translateY(-1px); }
.lhqv-btn:active { transform:translateY(0); }
.lhqv-btn-primary   { background:linear-gradient(135deg,#38bdf8,#2563eb); color:#fff; }
.lhqv-btn-secondary { background:rgba(51,65,85,0.9); color:#cbd5e1; border:1px solid rgba(148,163,184,0.18); }
.lhqv-btn-danger    { background:rgba(127,29,29,0.6); color:#fca5a5; border:1px solid rgba(239,68,68,0.25); }
.lhqv-btn-warning   { background:rgba(120,53,15,0.6); color:#fcd34d; border:1px solid rgba(245,158,11,0.3); }
.lhqv-btn-success   { background:rgba(20,83,45,0.6); color:#86efac; border:1px solid rgba(34,197,94,0.3); }
.lhqv-btn-theme     { background:rgba(51,65,85,0.7); color:#e2e8f0; border:1px solid rgba(148,163,184,0.2); font-size:16px; padding:0 10px; }
.theme-light .lhqv-btn-secondary { background:#e2e8f0; color:#1e293b; border:1px solid #cbd5e1; }
.theme-light .lhqv-btn-danger    { background:#fee2e2; color:#dc2626; border:1px solid #fca5a5; }
.theme-light .lhqv-btn-warning   { background:#fef3c7; color:#d97706; border:1px solid #fcd34d; }
.theme-light .lhqv-btn-success   { background:#dcfce7; color:#16a34a; border:1px solid #86efac; }
.theme-light .lhqv-btn-theme     { background:#e2e8f0; color:#1e293b; border:1px solid #cbd5e1; }

/* ── STATUS ── */
#lhqv-status-bar {
    margin-top:10px; padding:6px 10px;
    background:var(--bg-status); border-radius:8px;
    font-size:11px; font-weight:600; color:#93c5fd;
    border:1px solid var(--color-border); transition:color 0.3s;
}

/* ── CARDS ── */
#lhqv-cards {
    display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr));
    gap:10px; padding:12px 16px;
    background:var(--bg-cards); border-bottom:1px solid var(--color-border); flex-shrink:0;
}
.lhqv-card { background:var(--bg-card); border-radius:14px; padding:12px 14px; border-left:3px solid transparent; min-width:0; box-shadow:0 2px 8px rgba(0,0,0,0.1); transition:transform 0.15s; }
.lhqv-card:hover { transform:translateY(-2px); }
.lhqv-card:nth-child(1){ border-left-color:#22c55e; }
.lhqv-card:nth-child(2){ border-left-color:#38bdf8; }
.lhqv-card:nth-child(3){ border-left-color:#f59e0b; }
.lhqv-card:nth-child(4){ border-left-color:#a78bfa; }
.lhqv-card-label { font-size:10px; text-transform:uppercase; letter-spacing:0.08em; color:var(--color-text-muted); margin-bottom:5px; font-weight:700; }
.lhqv-card-value { font-size:clamp(18px,1.8vw,26px); font-weight:800; color:var(--color-title); line-height:1.1; word-break:break-word; }
.lhqv-card-sub   { margin-top:4px; font-size:11px; color:var(--color-text-dim); }
#lhqv-bar-wrap   { margin-top:8px; display:flex; gap:4px; height:6px; width:100%; border-radius:999px; overflow:hidden; }
.lhqv-bar-segment{ height:100%; min-width:6px; transition:width 0.4s ease; }

/* ── SEARCH ── */
#lhqv-search-wrap { padding:10px 14px; background:var(--bg-search-wrap); border-bottom:1px solid var(--color-border); flex-shrink:0; position:relative; }
#lhqv-search { width:100%; padding:10px 38px 10px 14px; background:var(--bg-search); border:1px solid var(--color-border); border-radius:10px; color:var(--color-text); font-size:13px; box-sizing:border-box; transition:border-color 0.15s,box-shadow 0.15s; }
#lhqv-search:focus { outline:none; border-color:rgba(56,189,248,0.75); box-shadow:0 0 0 3px rgba(56,189,248,0.10); }
#lhqv-search-clear { position:absolute; right:24px; top:50%; transform:translateY(-50%); background:none; border:none; color:var(--color-text-muted); font-size:16px; cursor:pointer; display:none; line-height:1; padding:2px 4px; }
#lhqv-search-clear:hover { color:var(--color-text); }

/* ── DAY TABLE ── */
#lhqv-table-wrap { flex:1; overflow:auto; padding:10px 12px; min-height:0; background:var(--bg-table-wrap); }
#lhqv-table { width:100%; border-collapse:separate; border-spacing:0 6px; }
#lhqv-table thead th { position:sticky; top:0; z-index:2; background:var(--bg-thead); padding:9px 12px; text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:0.07em; color:var(--color-text-head); user-select:none; }
#lhqv-table tbody td { padding:11px 12px; font-size:12px; color:var(--color-ctrl-text); border-top:1px solid var(--color-border); border-bottom:1px solid var(--color-border); background:var(--bg-td); vertical-align:middle; transition:background 0.12s; }
#lhqv-table tbody tr:hover td { background:var(--bg-td-hover); }
#lhqv-table tbody td:first-child { border-left:1px solid var(--color-border); border-radius:10px 0 0 10px; }
#lhqv-table tbody td:last-child  { border-right:1px solid var(--color-border); border-radius:0 10px 10px 0; }
.lhqv-category-row  td { background:var(--color-cat-bg)  !important; font-weight:900; cursor:pointer; }
.lhqv-category-row:hover td  { background:var(--color-cat-hover)  !important; }
.lhqv-subcategory-row td { background:var(--color-sub-bg)  !important; font-weight:800; cursor:pointer; }
.lhqv-subcategory-row:hover td { background:var(--color-sub-hover)  !important; }
.lhqv-process-row td  { background:var(--color-proc-bg) !important; font-weight:800; cursor:pointer; }
.lhqv-process-row:hover td  { background:var(--color-proc-hover) !important; }
.lhqv-breakout-row td { background:var(--color-br-bg)   !important; font-weight:700; cursor:pointer; }
.lhqv-breakout-row:hover td { background:var(--color-br-hover)   !important; }
.lhqv-group-title { display:flex; align-items:center; gap:8px; }
.lhqv-chevron { width:16px; display:inline-block; color:var(--color-text-head); font-size:11px; flex-shrink:0; }
.lhqv-category-title   { font-size:13px; }
.lhqv-subcategory-title{ padding-left:16px; }
.lhqv-process-title    { padding-left:32px; }
.lhqv-breakout-title   { padding-left:52px; }
.lhqv-group-meta  { color:var(--color-text-muted); font-weight:600; font-size:11px; }
.lhqv-worker-name { padding-left:72px !important; font-weight:700; color:var(--color-title); }
.lhqv-worker-sub  { color:var(--color-text-muted); font-size:11px; margin-top:2px; }
.lhqv-hours       { font-weight:800; color:var(--color-hrs); font-variant-numeric:tabular-nums; }

/* ── WEEK TABLE ── */
#lhqv-week-table { width:100%; border-collapse:collapse; font-size:12px; }
#lhqv-week-table thead tr { background:var(--color-wk-head); }
#lhqv-week-table thead th { padding:9px 12px; text-align:center; font-size:10px; text-transform:uppercase; letter-spacing:0.07em; color:var(--color-wk-head-text); border:1px solid var(--color-wk-border); font-weight:700; white-space:nowrap; position:sticky; top:0; z-index:2; }
#lhqv-week-table thead th:first-child { text-align:left; min-width:160px; }
.lhqv-week-date { font-size:9px; font-weight:400; opacity:0.7; }
#lhqv-week-table tbody td { padding:8px 12px; border:1px solid var(--color-wk-border); color:var(--color-wk-cell-text); vertical-align:middle; }
#lhqv-week-table tbody td:first-child { text-align:left; }
#lhqv-week-table tbody td:not(:first-child) { text-align:center; }
.lhqv-wk-cat-row td  { background:var(--color-wk-cat)  !important; font-weight:800; }
.lhqv-wk-cat-row:hover td { filter:brightness(1.05); }
.lhqv-wk-sub-row td  { background:var(--color-wk-sub); font-weight:500; }
.lhqv-wk-sub-row:hover td { background:var(--bg-td-hover); }
.lhqv-wk-total-row td { background:var(--color-wk-total) !important; font-weight:900; font-size:13px; }
.lhqv-today-col   { background:var(--color-wk-today) !important; }
.lhqv-week-total-col { font-weight:800; color:var(--color-hrs); }
.lhqv-wk-hrs  { font-weight:800; color:var(--color-hrs); font-variant-numeric:tabular-nums; }
.lhqv-wk-zero { color:var(--color-wk-zero); font-size:11px; }

/* ── SUMMARY BAR ── */
#lhqv-summary-bar { padding:8px 16px; background:var(--bg-summary); border-top:1px solid var(--color-border); font-size:11px; flex-shrink:0; display:flex; flex-wrap:wrap; gap:4px; align-items:center; }

/* ── BADGES ── */
.lhqv-badge { display:inline-flex; align-items:center; justify-content:center; padding:2px 9px; border-radius:999px; font-size:10px; font-weight:800; }
#lhqv-site-badge  { background:rgba(168,85,247,0.14); color:#d8b4fe; border:1px solid rgba(168,85,247,0.25); }
#lhqv-week-badge  { background:rgba(34,197,94,0.14);  color:#86efac; border:1px solid rgba(34,197,94,0.22); }
#lhqv-shift-badge.day   { background:rgba(251,191,36,0.14); color:#fde68a; border:1px solid rgba(251,191,36,0.25); }
#lhqv-shift-badge.night { background:rgba(96,165,250,0.14);  color:#93c5fd; border:1px solid rgba(96,165,250,0.25); }

@media (max-width:800px) {
    #lhqv-overlay { padding:4px; }
    #lhqv-shell { border-radius:12px; }
    #lhqv-controls { flex-direction:column; align-items:stretch; }
    #lhqv-controls-right { justify-content:flex-end; }
}
`;
}


function applyTheme(theme) {
    currentTheme = theme;
    localStorage.setItem('lhqv-theme', theme);
    const overlay = document.getElementById('lhqv-overlay');
    if (!overlay) return;
    overlay.classList.remove('theme-dark','theme-light');
    overlay.classList.add('theme-'+theme);
    const btn = document.getElementById('lhqv-theme-btn');
    if (btn) btn.textContent = theme === 'dark' ? '\u2600\ufe0f Light' : '\ud83c\udf19 Dark';
}

function createDashboard() {
    const oldOverlay = document.getElementById('lhqv-overlay');
    if (oldOverlay) oldOverlay.remove();
    const oldLauncher = document.getElementById('lhqv-launcher');
    if (oldLauncher) oldLauncher.remove();

    const launcher = document.createElement('button');
    launcher.id = 'lhqv-launcher';
    launcher.innerHTML = '&#9200;';
    launcher.title = 'Open Labour Hours Quick View';

    const overlay = document.createElement('div');
    overlay.id = 'lhqv-overlay';

    overlay.innerHTML = `
<style>${getThemeCSS()}</style>
<div id="lhqv-shell">
    <div id="lhqv-header">
        <div id="lhqv-header-top">
            <h2 id="lhqv-title">&#9200; Labour Hours Quick View</h2>
            <div id="lhqv-header-badges">
                <span id="lhqv-site-badge" class="lhqv-badge"></span>
                <span id="lhqv-shift-badge" class="lhqv-badge"></span>
                <span id="lhqv-week-badge" class="lhqv-badge"></span>
            </div>
        </div>
        <div id="lhqv-controls">
            <div id="lhqv-controls-left">
                <select id="lhqv-site-select"></select>
                <input type="date" id="lhqv-date-picker" title="Select date" />
                <select id="lhqv-view-mode">
                    <option value="DAY">Day View</option>
                    <option value="WEEK">Week View</option>
                </select>
                <select id="lhqv-shift-select"></select>
                <select id="lhqv-interval-select" title="Auto-refresh interval">
                    <option value="600000">Refresh: 10 min</option>
                    <option value="1800000">Refresh: 30 min</option>
                    <option value="3600000">Refresh: 60 min</option>
                </select>
            </div>
            <div id="lhqv-controls-right">
                <button class="lhqv-btn lhqv-btn-theme" id="lhqv-theme-btn" title="Toggle light/dark mode">&#9728;&#65039; Light</button>
                <button class="lhqv-btn lhqv-btn-primary" id="lhqv-refresh-btn">&#8635; Refresh</button>
                <button class="lhqv-btn lhqv-btn-warning" id="lhqv-pause-btn">&#9208; Pause</button>
                <button class="lhqv-btn lhqv-btn-secondary" id="lhqv-export-btn">&#8595; Export CSV</button>
                <button class="lhqv-btn lhqv-btn-danger" id="lhqv-close-btn">&#10005; Close</button>
            </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;margin-top:10px;">
            <div id="lhqv-status-bar" style="flex:1;">Starting...</div>
            <span id="lhqv-countdown" style="font-size:11px;font-weight:700;color:#64748b;white-space:nowrap;padding:6px 10px;background:var(--bg-status);border-radius:8px;border:1px solid var(--color-border);">&#9203; --:--</span>
        </div>
    </div>
    <div id="lhqv-cards">
        <div class="lhqv-card">
            <div class="lhqv-card-label">Total Labour Hours</div>
            <div class="lhqv-card-value" id="lhqv-total-hrs">0.00</div>
            <div class="lhqv-card-sub">All tracked categories</div>
            <div id="lhqv-bar-wrap"></div>
        </div>
        <div class="lhqv-card">
            <div class="lhqv-card-label">Associates</div>
            <div class="lhqv-card-value" id="lhqv-total-associates">0</div>
            <div class="lhqv-card-sub">Unique workers</div>
        </div>
        <div class="lhqv-card">
            <div class="lhqv-card-label">Categories</div>
            <div class="lhqv-card-value">${CATEGORY_TREE.length}</div>
            <div class="lhqv-card-sub">Tracked labour buckets</div>
        </div>
        <div class="lhqv-card">
            <div class="lhqv-card-label">Top Category</div>
            <div class="lhqv-card-value" id="lhqv-top-category">-</div>
            <div class="lhqv-card-sub" id="lhqv-top-category-sub">Waiting for data</div>
        </div>
    </div>
    <div id="lhqv-search-wrap">
        <input type="text" id="lhqv-search" placeholder="&#128269; Search by worker or manager..." />
        <button id="lhqv-search-clear" title="Clear search">&#10005;</button>
    </div>
    <div id="lhqv-table-wrap">
        <table id="lhqv-table">
            <thead><tr>
                <th>Category / Associate</th>
                <th>Manager</th>
                <th>Count / Detail</th>
                <th>Total Hours</th>
            </tr></thead>
            <tbody id="lhqv-table-body"></tbody>
        </table>
    </div>
    <div id="lhqv-summary-bar"></div>
</div>`;

    document.body.appendChild(launcher);
    document.body.appendChild(overlay);

    // Apply saved theme
    applyTheme(currentTheme);

    launcher.addEventListener('click', function(){ setDashboardOpen(true); });
    overlay.addEventListener('click', function(e){ if (e.target===overlay) setDashboardOpen(false); });
    document.getElementById('lhqv-close-btn').addEventListener('click', function(){ setDashboardOpen(false); });

    // Theme toggle
    document.getElementById('lhqv-theme-btn').addEventListener('click', function(){
        applyTheme(currentTheme==='dark'?'light':'dark');
    });

    // Site select
    const siteSelect=document.getElementById('lhqv-site-select');
    AVAILABLE_SITES.forEach(function(site){ const opt=document.createElement('option'); opt.value=site; opt.textContent=site; siteSelect.appendChild(opt); });
    siteSelect.value=selectedSite;
    siteSelect.addEventListener('change', function(){ selectedSite=this.value; if (!siteUsesShiftSelector()) selectedShift=null; populateShiftSelect(); updateHeaderBadges(); refreshData(); });

    // Date picker
    const datePicker=document.getElementById('lhqv-date-picker');
    datePicker.value=todayStr(); datePicker.max=todayStr();
    datePicker.addEventListener('change', function(){ selectedDate=this.value||null; refreshData(); });

    // View mode
    const viewMode=document.getElementById('lhqv-view-mode');
    viewMode.value=selectedViewMode;
    viewMode.addEventListener('change', function(){ selectedViewMode=this.value; updateHeaderBadges(); refreshData(); });

    // Shift select
    populateShiftSelect();
    document.getElementById('lhqv-shift-select').addEventListener('change', function(){ selectedShift=this.value||null; updateHeaderBadges(); refreshData(); });

    // Interval select
    const intervalSelect=document.getElementById('lhqv-interval-select');
    intervalSelect.value=String(refreshInterval);
    intervalSelect.addEventListener('change', function(){ refreshInterval=parseInt(this.value,10); resetRefreshTimer(); updateStatus('Auto-refresh set to '+refreshInterval/60000+' min','ok'); });

    // Buttons
    document.getElementById('lhqv-refresh-btn').addEventListener('click', function(){
        if (refreshPaused){ refreshPaused=false; }
        refreshData();
        const btn=document.getElementById('lhqv-pause-btn');
        if (btn){ btn.textContent='\u23f8 Pause'; btn.classList.remove('lhqv-btn-success'); btn.classList.add('lhqv-btn-warning'); }
    });
    document.getElementById('lhqv-pause-btn').addEventListener('click', function(){ togglePause(); });
    document.getElementById('lhqv-export-btn').addEventListener('click', function(){ exportCSV(); });

    // Search
    const searchInput=document.getElementById('lhqv-search');
    const clearBtn=document.getElementById('lhqv-search-clear');
    let searchTimer=null;
    searchInput.addEventListener('input', function(){ clearTimeout(searchTimer); clearBtn.style.display=this.value?'block':'none'; searchTimer=setTimeout(function(){ renderTable(); },150); });
    clearBtn.addEventListener('click', function(){ searchInput.value=''; clearBtn.style.display='none'; renderTable(); });

    // Keyboard shortcut
    document.addEventListener('keydown', function(e){ if (e.key==='Escape'&&isDashboardOpen) setDashboardOpen(false); });

    // Add status element alias
    const statusBar=document.getElementById('lhqv-status-bar');
    if (statusBar) statusBar.id='lhqv-status';

    updateHeaderBadges();
    setDashboardOpen(false);
}

createDashboard();
lastAutoShift=inferShift();
refreshData();
resetRefreshTimer();

})();
