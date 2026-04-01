// ==UserScript==
// @name         Labour Hours Quick View
// @namespace    http://tampermonkey.net/
// @version      5.6
// @description  Multi-site labour hours dashboard with full-screen layout, CSV export, site-specific shift windows, EOS-style breakout groups, day/week view, filtered JOB_ROLE tracking, LCY8 dual-shift week view, and improved UI
// @author       brdlnx
// @match        https://fclm-portal.amazon.com/*warehouseId=LCY8*
// @match        https://fclm-portal.amazon.com/*warehouseId=STN8*
// @match        https://fclm-portal.amazon.com/*warehouseId=SXW2*
// @match        https://fclm-portal.amazon.com/*warehouseId=SBS2*
// @grant        GM_xmlhttpRequest
// @connect      fclm-portal.amazon.com
// @updateURL    https://github.com/brdlnx-ld/Labour-Hours-Quick-View/raw/refs/heads/main/Labour%20Hours%20Quick%20View-5.6.user.js
// @downloadURL  https://github.com/brdlnx-ld/Labour-Hours-Quick-View/raw/refs/heads/main/Labour%20Hours%20Quick%20View-5.6.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const AVAILABLE_SITES = ['LCY8', 'STN8', 'SXW2', 'SBS2'];
    const DEFAULT_SITE = 'LCY8';
    const NODE_TYPE = 'SC';
    const REFRESH_INTERVAL = 5 * 60000;
    const BATCH_SIZE = 12;
    const BATCH_DELAY = 0;
    const WEEK_1_START = new Date('2025-12-28T00:00:00');

    const SITE_WINDOWS = {
        LCY8: {
            shifts: {
                DAY:   { label: 'Day (08:30\u201319:00)',   startHour: 8,  startMinute: 30, endHour: 19, endMinute: 0,  crossesMidnight: false },
                NIGHT: { label: 'Night (19:00\u201304:30)', startHour: 19, startMinute: 0,  endHour: 4,  endMinute: 30, crossesMidnight: true  }
            },
            defaultShift: 'DAY',
            hasShiftSelector: true
        },
        STN8: {
            shifts: {
                EOS: { label: 'EOS (07:00\u201306:00)', startHour: 8, startMinute: 30, endHour: 6, endMinute: 0, crossesMidnight: true }
            },
            defaultShift: 'EOS',
            hasShiftSelector: false
        },
        SBS2: {
            shifts: {
                EOS: { label: 'EOS (14:30\u201306:00)', startHour: 14, startMinute: 30, endHour: 6, endMinute: 0, crossesMidnight: true }
            },
            defaultShift: 'EOS',
            hasShiftSelector: false
        },
        SXW2: {
            shifts: {
                EOS: { label: 'EOS (11:00\u201306:00)', startHour: 11, startMinute: 0, endHour: 6, endMinute: 0, crossesMidnight: true }
            },
            defaultShift: 'EOS',
            hasShiftSelector: false
        }
    };

    const TRACKED_PROCESSES = {
        "SC Training": { processId: 100391, label: 'SC Training [100391]' },
        "Admin/HR": {
            processId: 100200, label: 'Admin/HR [100200]',
            filter: { attribute: 'JOB_ROLE', values: ['LN_FC_TRAING_EVENTS', 'LN_TDRCLASSRM_TRAING'] }
        },
        "Learning Ambassadors": { processId: 100384, label: 'Learning Ambassadors [100384]' },
        "Day 1 and 2 Insturctors": {
            processId: 100385, label: 'New Hires [100385]',
            filter: { attribute: 'JOB_ROLE', values: ['AMB NEW HIRE TRAINING'] }
        },
        "Day 1": { processId: 100243, label: 'On Boarding [100243]' },
        "Day 2": {
            processId: 100385, label: 'New Hires [100385]',
            filter: { attribute: 'JOB_ROLE', values: ['NEW HIRE TRAINING'] }
        }
    };

    const CATEGORY_TREE = [
        { name: 'Training Hours', flat: true, processKeys: ['SC Training', 'Admin/HR'] },
        {
            name: 'Instructor',
            children: [
                { name: 'Instructor', processKeys: ['Learning Ambassadors'] },
                { name: 'Day 1 and 2 Insturctors', processKeys: ['Day 1 and 2 Insturctors'] }
            ]
        },
        {
            name: 'New Hires',
            children: [
                { name: 'Day 1', processKeys: ['Day 1'] },
                { name: 'Day 2', processKeys: ['Day 2'] }
            ]
        }
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
    let isDashboardOpen = false;

    const dataCache = {};
    const categoryState = {};
    const subCategoryState = {};
    const breakoutState = {};
    const processState = {};

    function detectSiteFromUrl() {
        const href = window.location.href;
        for (const site of AVAILABLE_SITES) {
            if (href.includes('warehouseId=' + site)) return site;
        }
        return DEFAULT_SITE;
    }

    function getSiteConfig() { return SITE_WINDOWS[selectedSite] || SITE_WINDOWS[DEFAULT_SITE]; }
    function getAvailableShifts() { return getSiteConfig().shifts; }
    function getDefaultShiftForSite() { return getSiteConfig().defaultShift; }
    function siteUsesShiftSelector() { return !!getSiteConfig().hasShiftSelector; }

    function getEffectiveShift() {
        const shifts = getAvailableShifts();
        if (selectedShift && shifts[selectedShift]) return selectedShift;
        return getDefaultShiftForSite();
    }

    function getShiftWindow(shiftKey) {
        const shifts = getAvailableShifts();
        return shifts[shiftKey] || shifts[getDefaultShiftForSite()];
    }

    function pad2(n) { return String(n).padStart(2, '0'); }
    function fmtYMD(d) { return d.getFullYear() + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()); }
    function fmtISODate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
    function addDays(d, n) { const t = new Date(d); t.setDate(t.getDate() + n); return t; }
    function todayStr() { return fmtISODate(new Date()); }

    function inferShift() {
        const shifts = getAvailableShifts();
        if (!siteUsesShiftSelector()) return getDefaultShiftForSite();
        if (selectedShift && shifts[selectedShift]) return selectedShift;
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const keys = Object.keys(shifts);
        for (let i = 0; i < keys.length; i++) {
            const win = shifts[keys[i]];
            const start = new Date(today); start.setHours(win.startHour, win.startMinute, 0, 0);
            const end = new Date(today);
            if (win.crossesMidnight) end.setDate(end.getDate() + 1);
            end.setHours(win.endHour, win.endMinute, 0, 0);
            if (now >= start && now <= end) return keys[i];
            if (win.crossesMidnight) {
                const yStart = addDays(start, -1); const yEnd = addDays(end, -1);
                if (now >= yStart && now <= yEnd) return keys[i];
            }
        }
        return getDefaultShiftForSite();
    }

    function getOperationalNowBaseDate() {
        let base = new Date();
        const shiftKey = getEffectiveShift();
        const win = getShiftWindow(shiftKey);
        if (win.crossesMidnight) {
            const h = base.getHours(); const m = base.getMinutes();
            if (h < win.endHour || (h === win.endHour && m <= win.endMinute)) base = addDays(base, -1);
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
        const baseDate = selectedDate ? new Date(selectedDate + 'T12:00:00') : getOperationalNowBaseDate();
        const weekStart = getWeekStart(baseDate);
        const dates = [];
        for (let i = 0; i < 7; i++) dates.push(addDays(weekStart, i));
        return dates;
    }

    function getWeekLabelText() {
        const baseDate = selectedDate ? new Date(selectedDate + 'T12:00:00') : getOperationalNowBaseDate();
        const weekNo = getWeekNumber(baseDate);
        const weekStart = getWeekStart(baseDate);
        const weekEnd = addDays(weekStart, 6);
        return 'Week ' + weekNo + ' \u00b7 ' + fmtISODate(weekStart) + ' to ' + fmtISODate(weekEnd);
    }

    function getCacheKey() {
        const dateKey = selectedDate || todayStr();
        const shiftKey = getEffectiveShift();
        return selectedSite + '|' + selectedViewMode + '|' + dateKey + '|' + shiftKey;
    }

    function isHistorical() { return selectedDate && selectedDate !== todayStr(); }
    function resetRefreshTimer() {
        if (refreshTimerId) clearInterval(refreshTimerId);
        refreshTimerId = setInterval(autoRefresh, REFRESH_INTERVAL);
    }

    function buildPPAUrl(processConfig, forcedDateStr, forcedShiftKey) {
        let base = forcedDateStr ? new Date(forcedDateStr + 'T12:00:00') : (selectedDate ? new Date(selectedDate + 'T12:00:00') : new Date());
        const shiftKey = forcedShiftKey || getEffectiveShift();
        const win = getShiftWindow(shiftKey);
        if (!forcedDateStr && !selectedDate && win.crossesMidnight) {
            const h = base.getHours(); const m = base.getMinutes();
            if (h < win.endHour || (h === win.endHour && m <= win.endMinute)) base = addDays(base, -1);
        }
        const startDate = new Date(base.getFullYear(), base.getMonth(), base.getDate());
        const endDate = win.crossesMidnight ? addDays(startDate, 1) : startDate;
        return 'https://fclm-portal.amazon.com/ppa/inspect/process'
            + '?nodeType=' + NODE_TYPE + '&warehouseId=' + selectedSite
            + '&processId=' + processConfig.processId
            + '&primaryAttribute=JOB_ROLE&secondaryAttribute=JOB_ROLE&spanType=Intraday'
            + '&startDateDay=' + encodeURIComponent(fmtYMD(startDate))
            + '&startDateIntraday=' + encodeURIComponent(fmtYMD(startDate))
            + '&startHourIntraday=' + win.startHour + '&startMinuteIntraday=' + win.startMinute
            + '&endDateIntraday=' + encodeURIComponent(fmtYMD(endDate))
            + '&endHourIntraday=' + win.endHour + '&endMinuteIntraday=' + win.endMinute
            + '&maxIntradayDays=1';
    }

    function extractProductivityList(html) {
        try {
            const match = html.match(/filteredProductivityList\s*=\s*(\[[\s\S]*?\]);\s*(?:var|let|const|\/\/|function|\n)/);
            if (match) return JSON.parse(match[1]);
        } catch (e) {}
        const marker = 'filteredProductivityList = [';
        let startIdx = html.indexOf(marker);
        if (startIdx === -1) return null;
        startIdx += marker.length - 1;
        let depth = 0;
        for (let i = startIdx; i < html.length; i++) {
            if (html[i] === '[') depth++;
            if (html[i] === ']') depth--;
            if (depth === 0) { try { return JSON.parse(html.substring(startIdx, i + 1)); } catch (e) { return null; } }
        }
        return null;
    }

    function getCandidateValues(processAttributes, attributeName) {
        const out = []; const targetKey = String(attributeName).toLowerCase();
        if (processAttributes && processAttributes[attributeName] != null) out.push(String(processAttributes[attributeName]).trim());
        for (const key in processAttributes || {}) {
            if (String(key).toLowerCase() === targetKey && processAttributes[key] != null) out.push(String(processAttributes[key]).trim());
        }
        const nested = (processAttributes && processAttributes.attributes) || {};
        if (nested[attributeName] != null) out.push(String(nested[attributeName]).trim());
        for (const key in nested) {
            if (String(key).toLowerCase() === targetKey && nested[key] != null) out.push(String(nested[key]).trim());
        }
        return Array.from(new Set(out.filter(Boolean)));
    }

    function valueMatchesFilter(processAttributes, filter) {
        if (!filter) return true;
        const wantedValues = (filter.values || (filter.value ? [filter.value] : [])).map(v => String(v).trim());
        if (wantedValues.length === 0) return true;
        const candidates = getCandidateValues(processAttributes, filter.attribute);
        return candidates.some(c => wantedValues.includes(c));
    }

    function getBreakoutValue(processAttributes, processConfig) {
        if (!processAttributes) return 'UNSPECIFIED';
        const attrName = processConfig && processConfig.breakoutAttribute ? processConfig.breakoutAttribute : 'JOB_ROLE';
        const candidates = getCandidateValues(processAttributes, attrName);
        return candidates[0] || 'UNSPECIFIED';
    }

    function aggregateData(productivityList, processLabel, processConfig) {
        if (!rates[processLabel]) rates[processLabel] = { workers: {}, breakouts: {} };
        const store = rates[processLabel];
        const filter = processConfig && processConfig.filter ? processConfig.filter : null;
        for (let i = 0; i < productivityList.length; i++) {
            const entry = productivityList[i];
            const processAttributes = entry.processAttributes || {};
            if (filter && !valueMatchesFilter(processAttributes, filter)) continue;
            const trackingType = processAttributes.laborTrackingType || '';
            const associates = entry.associateProductivityList || [];
            const breakoutValue = getBreakoutValue(processAttributes, processConfig);
            if (!store.breakouts[breakoutValue]) store.breakouts[breakoutValue] = { name: breakoutValue, workers: {} };
            const seen = {};
            for (let j = 0; j < associates.length; j++) {
                const a = associates[j]; const empId = a.employeeId;
                const name = a.employeeName || ''; const managerName = a.managerName || '';
                if (!empId || seen[empId]) continue;
                seen[empId] = true;
                const rawTime = Number(a.timeMillis || a.timeSeconds || 0);
                const hours = rawTime / 3600;
                if (!store.workers[empId]) store.workers[empId] = { employeeId: empId, employeeName: name, managerName: managerName, totalDirect: 0, totalIndirect: 0, totalHrs: 0 };
                if (!store.breakouts[breakoutValue].workers[empId]) store.breakouts[breakoutValue].workers[empId] = { employeeId: empId, employeeName: name, managerName: managerName, totalDirect: 0, totalIndirect: 0, totalHrs: 0 };
                const workerRec = store.workers[empId]; const breakoutWorkerRec = store.breakouts[breakoutValue].workers[empId];
                if (trackingType === 'direct') { workerRec.totalDirect += hours; breakoutWorkerRec.totalDirect += hours; }
                else { workerRec.totalIndirect += hours; breakoutWorkerRec.totalIndirect += hours; }
                workerRec.totalHrs = workerRec.totalDirect + workerRec.totalIndirect;
                breakoutWorkerRec.totalHrs = breakoutWorkerRec.totalDirect + breakoutWorkerRec.totalIndirect;
            }
        }
    }

    function loadProcess(processLabel, processConfig, onDone, thisGen, forcedDateStr, forcedShiftKey) {
        const url = buildPPAUrl(processConfig, forcedDateStr, forcedShiftKey);
        GM_xmlhttpRequest({
            method: 'GET', url: url, timeout: 15000,
            onload: function (response) {
                if (thisGen !== refreshGeneration) return;
                if (response.status >= 200 && response.status < 300) {
                    const list = extractProductivityList(response.responseText);
                    if (list) aggregateData(list, processLabel, processConfig);
                    onDone(processLabel, !!list);
                } else { onDone(processLabel, false); }
            },
            onerror: function () { onDone(processLabel, false); },
            ontimeout: function () { onDone(processLabel, false); }
        });
    }

    function refreshData() {
        const cacheKey = getCacheKey();
        if (isHistorical() && dataCache[cacheKey]) {
            for (const key in rates) delete rates[key];
            const cached = dataCache[cacheKey];
            for (const key in cached) rates[key] = JSON.parse(JSON.stringify(cached[key]));
            lastRefresh = new Date();
            updateHeaderBadges();
            updateStatus('Loaded from cache \u00b7 ' + selectedSite + ' \u00b7 ' + (selectedViewMode === 'WEEK' ? getWeekLabelText() : ((selectedDate || 'Today') + ' \u00b7 ' + getShiftWindow(getEffectiveShift()).label)), 'ok');
            renderTable();
            resetRefreshTimer();
            return;
        }

        refreshGeneration++;
        const thisGeneration = refreshGeneration;
        for (const key in rates) delete rates[key];

        const entries = Object.entries(TRACKED_PROCESSES);
        const failedProcesses = [];
        let workItems = [];

        if (selectedViewMode === 'DAY') {
            totalToLoad = entries.length;
            const forcedDateStr = selectedDate || null;
            const forcedShiftKey = getEffectiveShift();
            entries.forEach(function (entry) {
                workItems.push({ label: entry[0], config: entry[1], dateStr: forcedDateStr, shiftKey: forcedShiftKey });
            });
        } else {
            // WEEK VIEW: LCY8 loads both DAY + NIGHT; other sites load single EOS shift
            const weekDates = getWeekDatesForSelectedContext();
            const shiftsToLoad = (selectedSite === 'LCY8')
                ? Object.keys(getAvailableShifts())   // ['DAY', 'NIGHT']
                : [getEffectiveShift()];               // other sites: EOS only

            totalToLoad = entries.length * weekDates.length * shiftsToLoad.length;

            weekDates.forEach(function (dateObj) {
                const dateStr = fmtISODate(dateObj);
                shiftsToLoad.forEach(function (shiftKey) {
                    entries.forEach(function (entry) {
                        workItems.push({ label: entry[0], config: entry[1], dateStr: dateStr, shiftKey: shiftKey });
                    });
                });
            });
        }

        loadedCount = 0;
        updateStatus('Loading 0/' + totalToLoad + '...', 'loading');

        function onProcessDone(lbl, success) {
            if (thisGeneration !== refreshGeneration) return;
            if (!success) failedProcesses.push(lbl);
            loadedCount++;
            updateStatus('Loading ' + loadedCount + '/' + totalToLoad + '...', 'loading');
            renderTable();
            if (loadedCount >= totalToLoad) {
                lastRefresh = new Date();
                updateHeaderBadges();
                let statusMsg;
                if (selectedViewMode === 'WEEK') {
                    const shiftNote = (selectedSite === 'LCY8') ? ' \u00b7 Day + Night' : '';
                    statusMsg = 'Loaded \u00b7 ' + selectedSite + ' \u00b7 ' + getWeekLabelText() + shiftNote + ' \u00b7 ' + lastRefresh.toLocaleTimeString();
                } else {
                    const dateLabel = selectedDate || 'Today';
                    const shiftLabel = getShiftWindow(getEffectiveShift()).label;
                    statusMsg = 'Loaded \u00b7 ' + selectedSite + ' \u00b7 ' + dateLabel + ' \u00b7 ' + shiftLabel + ' \u00b7 ' + lastRefresh.toLocaleTimeString();
                }
                if (failedProcesses.length > 0) statusMsg += ' \u00b7 ' + failedProcesses.length + ' failed';
                updateStatus(statusMsg, failedProcesses.length > 0 ? 'error' : 'ok');
                if (isHistorical()) {
                    dataCache[cacheKey] = {};
                    for (const k in rates) dataCache[cacheKey][k] = JSON.parse(JSON.stringify(rates[k]));
                }
            }
        }

        function launchBatch(startIndex) {
            if (thisGeneration !== refreshGeneration) return;
            const end = Math.min(startIndex + BATCH_SIZE, workItems.length);
            for (let i = startIndex; i < end; i++) {
                const item = workItems[i];
                loadProcess(item.label, item.config, onProcessDone, thisGeneration, item.dateStr, item.shiftKey);
            }
            if (end < workItems.length) setTimeout(function () { launchBatch(end); }, BATCH_DELAY);
        }

        launchBatch(0);
        resetRefreshTimer();
    }

    function normaliseProcessData(procKey) {
        const procData = rates[procKey] || { workers: {}, breakouts: {} };
        const workers = Object.values(procData.workers || {}).sort((a, b) => b.totalHrs - a.totalHrs);
        const breakouts = Object.keys(procData.breakouts || {}).map(function (breakoutName) {
            const breakout = procData.breakouts[breakoutName];
            const breakoutWorkers = Object.values(breakout.workers || {}).sort((a, b) => b.totalHrs - a.totalHrs);
            return {
                name: breakoutName,
                associates: breakoutWorkers.length,
                totalHrs: breakoutWorkers.reduce((sum, w) => sum + w.totalHrs, 0),
                workers: breakoutWorkers
            };
        }).sort((a, b) => b.totalHrs !== a.totalHrs ? b.totalHrs - a.totalHrs : a.name.localeCompare(b.name));
        return {
            processKey: procKey,
            processLabel: TRACKED_PROCESSES[procKey].label || procKey,
            associates: workers.length,
            totalHrs: workers.reduce((sum, w) => sum + w.totalHrs, 0),
            workers: workers,
            breakouts: breakouts
        };
    }

    function collectWorkersForProcessKeys(processKeys) {
        const workersMap = {};
        let totalHrs = 0;
        const processBreakdowns = [];
        processKeys.forEach(function (procKey) {
            const procNorm = normaliseProcessData(procKey);
            processBreakdowns.push(procNorm);
            procNorm.workers.forEach(function (r) {
                if (!workersMap[r.employeeId]) workersMap[r.employeeId] = { id: r.employeeId, name: r.employeeName, manager: r.managerName, totalHrs: 0, processes: [] };
                workersMap[r.employeeId].totalHrs += r.totalHrs;
                workersMap[r.employeeId].processes.push(procNorm.processLabel);
                totalHrs += r.totalHrs;
            });
        });
        const workers = Object.values(workersMap).sort((a, b) => b.totalHrs - a.totalHrs);
        processBreakdowns.sort((a, b) => b.totalHrs !== a.totalHrs ? b.totalHrs - a.totalHrs : a.processLabel.localeCompare(b.processLabel));
        return { workers, associates: workers.length, totalHrs, processBreakdowns };
    }

    function getGroupedCategoryData() {
        const categories = [];
        let grandAssociates = 0; let grandHours = 0;
        CATEGORY_TREE.forEach(function (category) {
            if (category.flat) {
                const flatData = collectWorkersForProcessKeys(category.processKeys);
                grandAssociates += flatData.associates; grandHours += flatData.totalHrs;
                categories.push({ name: category.name, associates: flatData.associates, totalHrs: flatData.totalHrs, workers: flatData.workers, flat: true, processBreakdowns: flatData.processBreakdowns, children: [] });
                return;
            }
            const categoryWorkersMap = {}; let categoryHours = 0; const children = [];
            category.children.forEach(function (subCat) {
                const subData = collectWorkersForProcessKeys(subCat.processKeys);
                subData.workers.forEach(function (worker) {
                    if (!categoryWorkersMap[worker.id]) categoryWorkersMap[worker.id] = { id: worker.id, name: worker.name, manager: worker.manager, totalHrs: 0, processes: [] };
                    categoryWorkersMap[worker.id].totalHrs += worker.totalHrs;
                    categoryWorkersMap[worker.id].processes = categoryWorkersMap[worker.id].processes.concat(worker.processes);
                });
                categoryHours += subData.totalHrs;
                children.push({ name: subCat.name, processKeys: subCat.processKeys.slice(), associates: subData.associates, totalHrs: subData.totalHrs, workers: subData.workers, processBreakdowns: subData.processBreakdowns });
            });
            const categoryWorkers = Object.values(categoryWorkersMap).sort((a, b) => b.totalHrs - a.totalHrs);
            grandAssociates += categoryWorkers.length; grandHours += categoryHours;
            categories.push({ name: category.name, associates: categoryWorkers.length, totalHrs: categoryHours, workers: categoryWorkers, flat: false, children });
        });
        return { categories, totalAssociates: grandAssociates, totalHrs: grandHours };
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
            Object.keys(shifts).forEach(function (shiftKey) {
                const opt = document.createElement('option');
                opt.value = shiftKey; opt.textContent = shifts[shiftKey].label;
                shiftSelect.appendChild(opt);
            });
            shiftSelect.value = selectedShift || '';
        } else {
            Object.keys(shifts).forEach(function (shiftKey) {
                const opt = document.createElement('option');
                opt.value = shiftKey; opt.textContent = shifts[shiftKey].label;
                shiftSelect.appendChild(opt);
            });
            shiftSelect.value = getDefaultShiftForSite();
        }
    }

    function setDashboardOpen(open) {
        const overlay = document.getElementById('lhqv-overlay');
        const launcher = document.getElementById('lhqv-launcher');
        if (!overlay || !launcher) return;
        isDashboardOpen = open;
        overlay.classList.toggle('open', open);
        launcher.style.display = open ? 'none' : 'flex';
        document.body.style.overflow = open ? 'hidden' : '';
    }

    function escapeCSV(value) {
        const str = String(value ?? '');
        if (str.includes('"') || str.includes(',') || str.includes('\n')) return '"' + str.replace(/"/g, '""') + '"';
        return str;
    }

    function buildCSVRows() {
        const rows = []; const grouped = getGroupedCategoryData();
        grouped.categories.forEach(function (category) {
            if (category.flat) {
                category.processBreakdowns.forEach(function (processItem) {
                    processItem.breakouts.forEach(function (breakout) {
                        breakout.workers.forEach(function (worker) {
                            rows.push({ site: selectedSite, viewMode: selectedViewMode, dateOrWeek: selectedViewMode === 'WEEK' ? getWeekLabelText() : (selectedDate || todayStr()), operationalWindow: getShiftWindow(getEffectiveShift()).label, category: category.name, subCategory: '', process: processItem.processLabel, breakout: breakout.name, employeeId: worker.employeeId, employeeName: worker.employeeName, manager: worker.managerName || '', totalHours: worker.totalHrs.toFixed(2) });
                        });
                    });
                });
            } else {
                category.children.forEach(function (child) {
                    child.processBreakdowns.forEach(function (processItem) {
                        processItem.breakouts.forEach(function (breakout) {
                            breakout.workers.forEach(function (worker) {
                                rows.push({ site: selectedSite, viewMode: selectedViewMode, dateOrWeek: selectedViewMode === 'WEEK' ? getWeekLabelText() : (selectedDate || todayStr()), operationalWindow: getShiftWindow(getEffectiveShift()).label, category: category.name, subCategory: child.name, process: processItem.processLabel, breakout: breakout.name, employeeId: worker.employeeId, employeeName: worker.employeeName, manager: worker.managerName || '', totalHours: worker.totalHrs.toFixed(2) });
                            });
                        });
                    });
                });
            }
        });
        return rows;
    }

    function exportCSV() {
        const rows = buildCSVRows();
        if (!rows.length) { updateStatus('No data to export.', 'error'); return; }
        const header = ['Site','View Mode','Date/Week','Operational Window','Category','Sub Category','Process','Breakout','Employee ID','Employee Name','Manager','Total Hours'];
        let csv = header.join(',') + '\n';
        rows.forEach(function (row) {
            csv += [escapeCSV(row.site),escapeCSV(row.viewMode),escapeCSV(row.dateOrWeek),escapeCSV(row.operationalWindow),escapeCSV(row.category),escapeCSV(row.subCategory),escapeCSV(row.process),escapeCSV(row.breakout),escapeCSV(row.employeeId),escapeCSV(row.employeeName),escapeCSV(row.manager),escapeCSV(row.totalHours)].join(',') + '\n';
        });
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); const now = new Date();
        a.href = url;
        a.download = [selectedSite,'labour_hours',selectedViewMode.toLowerCase(),selectedViewMode === 'WEEK' ? ('week_' + getWeekNumber(selectedDate ? new Date(selectedDate + 'T12:00:00') : getOperationalNowBaseDate())) : (selectedDate || todayStr()), now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate()), pad2(now.getHours()) + pad2(now.getMinutes())].join('_') + '.csv';
        document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        updateStatus('CSV exported.', 'ok');
    }

    function renderCards(grouped) {
        const totalHrsEl = document.getElementById('lhqv-total-hrs');
        const totalAssociatesEl = document.getElementById('lhqv-total-associates');
        const topCategoryEl = document.getElementById('lhqv-top-category');
        const topCategorySubEl = document.getElementById('lhqv-top-category-sub');
        const barWrap = document.getElementById('lhqv-bar-wrap');
        if (!totalHrsEl || !totalAssociatesEl || !topCategoryEl || !topCategorySubEl || !barWrap) return;
        totalHrsEl.textContent = grouped.totalHrs.toFixed(2);
        totalAssociatesEl.textContent = grouped.totalAssociates;
        const topCategory = grouped.categories.slice().sort((a, b) => b.totalHrs - a.totalHrs)[0];
        if (topCategory && topCategory.totalHrs > 0) {
            topCategoryEl.textContent = topCategory.name;
            topCategorySubEl.textContent = topCategory.totalHrs.toFixed(2) + ' hrs \u00b7 ' + topCategory.associates + ' associates';
        } else { topCategoryEl.textContent = '-'; topCategorySubEl.textContent = 'Waiting for data'; }
        const palette = ['#22c55e', '#38bdf8', '#f59e0b', '#a78bfa', '#ef4444', '#14b8a6'];
        barWrap.innerHTML = '';
        grouped.categories.forEach(function (cat, index) {
            if (grouped.totalHrs <= 0 || cat.totalHrs <= 0) return;
            const seg = document.createElement('div');
            seg.className = 'lhqv-bar-segment';
            seg.style.width = ((cat.totalHrs / grouped.totalHrs) * 100).toFixed(2) + '%';
            seg.style.background = palette[index % palette.length];
            seg.title = cat.name + ': ' + cat.totalHrs.toFixed(2) + ' hrs';
            barWrap.appendChild(seg);
        });
    }

    function renderProcessBreakdowns(tbody, processBreakdowns, searchTerm, parentKeyBase) {
        processBreakdowns.forEach(function (processItem) {
            let visibleBreakouts = processItem.breakouts;
            if (searchTerm) {
                visibleBreakouts = processItem.breakouts.map(function (breakout) {
                    const filteredWorkers = breakout.workers.filter(w => (w.employeeName || '').toLowerCase().includes(searchTerm) || (w.managerName || '').toLowerCase().includes(searchTerm));
                    return Object.assign({}, breakout, { workers: filteredWorkers, associates: filteredWorkers.length, totalHrs: filteredWorkers.reduce((s, w) => s + w.totalHrs, 0) });
                }).filter(b => b.workers.length > 0);
            }
            if (!visibleBreakouts.length) return;
            const processKey = parentKeyBase + '||PROC||' + processItem.processKey;
            const processExpanded = !!processState[processKey];
            const processAssocCount = visibleBreakouts.reduce((s, b) => s + b.associates, 0);
            const processHours = visibleBreakouts.reduce((s, b) => s + b.totalHrs, 0);
            const processRow = document.createElement('tr');
            processRow.className = 'lhqv-process-row';
            processRow.innerHTML = `<td><div class="lhqv-group-title lhqv-process-title"><span class="lhqv-chevron">${processExpanded ? '&#9660;' : '&#9654;'}</span><span>${processItem.processLabel}</span></div></td><td><span class="lhqv-group-meta">EOS Process</span></td><td>${processAssocCount} associate${processAssocCount === 1 ? '' : 's'}</td><td class="lhqv-hours">${processHours.toFixed(2)}</td>`;
            processRow.addEventListener('click', function (e) { e.stopPropagation(); processState[processKey] = !processExpanded; renderTable(); });
            tbody.appendChild(processRow);
            if (processExpanded) {
                visibleBreakouts.forEach(function (breakout) {
                    const breakoutKey = processKey + '||BR||' + breakout.name;
                    const breakoutExpanded = !!breakoutState[breakoutKey];
                    const breakoutRow = document.createElement('tr');
                    breakoutRow.className = 'lhqv-breakout-row';
                    breakoutRow.innerHTML = `<td><div class="lhqv-group-title lhqv-breakout-title"><span class="lhqv-chevron">${breakoutExpanded ? '&#9660;' : '&#9654;'}</span><span>${breakout.name}</span></div></td><td><span class="lhqv-group-meta">JOB_ROLE</span></td><td>${breakout.associates} associate${breakout.associates === 1 ? '' : 's'}</td><td class="lhqv-hours">${breakout.totalHrs.toFixed(2)}</td>`;
                    breakoutRow.addEventListener('click', function (e) { e.stopPropagation(); breakoutState[breakoutKey] = !breakoutExpanded; renderTable(); });
                    tbody.appendChild(breakoutRow);
                    if (breakoutExpanded) {
                        breakout.workers.forEach(function (worker) {
                            const row = document.createElement('tr');
                            row.innerHTML = `<td class="lhqv-worker-name">${worker.employeeName}<div class="lhqv-worker-sub">ID: ${worker.employeeId}</div></td><td>${worker.managerName || '-'}</td><td>${processItem.processLabel}</td><td class="lhqv-hours">${worker.totalHrs.toFixed(2)}</td>`;
                            tbody.appendChild(row);
                        });
                    }
                });
            }
        });
    }

    function renderTable() {
        const tbody = document.getElementById('lhqv-table-body');
        if (!tbody) return;
        const searchInput = document.getElementById('lhqv-search');
        const searchTerm = (searchInput ? searchInput.value : '').toLowerCase().trim();
        const grouped = getGroupedCategoryData();
        renderCards(grouped);
        tbody.innerHTML = '';
        if (!grouped.categories.length) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#64748b;padding:24px;border-radius:12px;">No data yet</td></tr>';
            updateSummary(grouped, searchTerm); return;
        }
        let shownAny = false;
        grouped.categories.forEach(function (category) {
            if (category.flat) {
                let visibleWorkers = category.workers;
                let visibleProcesses = category.processBreakdowns;
                if (searchTerm) {
                    visibleWorkers = category.workers.filter(w => (w.name || '').toLowerCase().includes(searchTerm) || (w.manager || '').toLowerCase().includes(searchTerm));
                    visibleProcesses = category.processBreakdowns.map(function (proc) {
                        const filteredBreakouts = proc.breakouts.map(function (br) {
                            const fw = br.workers.filter(w => (w.employeeName || '').toLowerCase().includes(searchTerm) || (w.managerName || '').toLowerCase().includes(searchTerm));
                            return Object.assign({}, br, { workers: fw, associates: fw.length, totalHrs: fw.reduce((s, w) => s + w.totalHrs, 0) });
                        }).filter(br => br.workers.length > 0);
                        return Object.assign({}, proc, { breakouts: filteredBreakouts });
                    }).filter(proc => proc.breakouts.length > 0);
                }
                if (!searchTerm || visibleWorkers.length > 0 || visibleProcesses.length > 0) {
                    shownAny = true;
                    const catExpanded = !!categoryState[category.name];
                    const assocCount = searchTerm ? visibleWorkers.length : category.associates;
                    const hours = searchTerm ? visibleWorkers.reduce((s, w) => s + w.totalHrs, 0) : category.totalHrs;
                    const catRow = document.createElement('tr');
                    catRow.className = 'lhqv-category-row';
                    catRow.innerHTML = `<td><div class="lhqv-group-title lhqv-category-title"><span class="lhqv-chevron">${catExpanded ? '&#9660;' : '&#9654;'}</span><span>${category.name}</span></div></td><td><span class="lhqv-group-meta">Combined</span></td><td>${assocCount} associate${assocCount === 1 ? '' : 's'}</td><td class="lhqv-hours">${hours.toFixed(2)}</td>`;
                    catRow.addEventListener('click', function () { categoryState[category.name] = !catExpanded; renderTable(); });
                    tbody.appendChild(catRow);
                    if (catExpanded) renderProcessBreakdowns(tbody, visibleProcesses, searchTerm, category.name);
                }
                return;
            }
            let visibleChildren = category.children;
            if (searchTerm) {
                visibleChildren = category.children.map(function (child) {
                    const fw = child.workers.filter(w => (w.name || '').toLowerCase().includes(searchTerm) || (w.manager || '').toLowerCase().includes(searchTerm));
                    const fp = child.processBreakdowns.map(function (proc) {
                        const fb = proc.breakouts.map(function (br) {
                            const fwb = br.workers.filter(w => (w.employeeName || '').toLowerCase().includes(searchTerm) || (w.managerName || '').toLowerCase().includes(searchTerm));
                            return Object.assign({}, br, { workers: fwb, associates: fwb.length, totalHrs: fwb.reduce((s, w) => s + w.totalHrs, 0) });
                        }).filter(br => br.workers.length > 0);
                        return Object.assign({}, proc, { breakouts: fb });
                    }).filter(proc => proc.breakouts.length > 0);
                    return Object.assign({}, child, { workers: fw, associates: fw.length, totalHrs: fw.reduce((s, w) => s + w.totalHrs, 0), processBreakdowns: fp });
                }).filter(child => child.workers.length > 0 || child.processBreakdowns.length > 0);
                if (!visibleChildren.length) return;
            }
            shownAny = true;
            const catExpanded = !!categoryState[category.name];
            const categoryAssocCount = visibleChildren.reduce((s, c) => s + c.associates, 0);
            const categoryHours = visibleChildren.reduce((s, c) => s + c.totalHrs, 0);
            const catRow = document.createElement('tr');
            catRow.className = 'lhqv-category-row';
            catRow.innerHTML = `<td><div class="lhqv-group-title lhqv-category-title"><span class="lhqv-chevron">${catExpanded ? '&#9660;' : '&#9654;'}</span><span>${category.name}</span></div></td><td><span class="lhqv-group-meta">Category Total</span></td><td>${categoryAssocCount} associate${categoryAssocCount === 1 ? '' : 's'}</td><td class="lhqv-hours">${categoryHours.toFixed(2)}</td>`;
            catRow.addEventListener('click', function () { categoryState[category.name] = !catExpanded; renderTable(); });
            tbody.appendChild(catRow);
            if (catExpanded) {
                visibleChildren.forEach(function (child) {
                    const subKey = category.name + '||' + child.name;
                    const subExpanded = !!subCategoryState[subKey];
                    const subRow = document.createElement('tr');
                    subRow.className = 'lhqv-subcategory-row';
                    subRow.innerHTML = `<td><div class="lhqv-group-title lhqv-subcategory-title"><span class="lhqv-chevron">${subExpanded ? '&#9660;' : '&#9654;'}</span><span>${child.name}</span></div></td><td><span class="lhqv-group-meta">${child.processKeys.join(', ')}</span></td><td>${child.associates} associate${child.associates === 1 ? '' : 's'}</td><td class="lhqv-hours">${child.totalHrs.toFixed(2)}</td>`;
                    subRow.addEventListener('click', function (e) { e.stopPropagation(); subCategoryState[subKey] = !subExpanded; renderTable(); });
                    tbody.appendChild(subRow);
                    if (subExpanded) renderProcessBreakdowns(tbody, child.processBreakdowns, searchTerm, subKey);
                });
            }
        });
        if (!shownAny) tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#64748b;padding:24px;border-radius:12px;">No matches found</td></tr>';
        updateSummary(grouped, searchTerm);
    }

    function updateSummary(grouped, searchTerm) {
        const bar = document.getElementById('lhqv-summary-bar');
        if (!bar) return;
        const openCats = Object.keys(categoryState).filter(k => categoryState[k]).length;
        const openSubs = Object.keys(subCategoryState).filter(k => subCategoryState[k]).length;
        const openProcesses = Object.keys(processState).filter(k => processState[k]).length;
        const openBreakouts = Object.keys(breakoutState).filter(k => breakoutState[k]).length;

        const parts = [
            { label: selectedSite, color: '#d8b4fe' },
            { label: grouped.totalAssociates + ' associates', color: '#86efac' },
            { label: grouped.totalHrs.toFixed(2) + ' hrs total', color: '#7dd3fc' },
            { label: openCats + ' cats \u00b7 ' + openSubs + ' subs \u00b7 ' + openProcesses + ' procs \u00b7 ' + openBreakouts + ' breakouts open', color: '#94a3b8' }
        ];
        if (selectedViewMode === 'WEEK') parts.push({ label: getWeekLabelText(), color: '#86efac' });
        if (searchTerm) parts.push({ label: '\u{1F50D} "' + searchTerm + '"', color: '#fde68a' });

        bar.innerHTML = parts.map(p => `<span style="color:${p.color};margin-right:16px;">${p.label}</span>`).join('<span style="color:#334155;margin-right:16px;">|</span>');
    }

    function updateStatus(msg, state) {
        const el = document.getElementById('lhqv-status');
        if (!el) return;
        el.textContent = msg;
        if (state === 'loading') { el.style.color = '#93c5fd'; el.style.fontStyle = 'italic'; }
        else if (state === 'ok') { el.style.color = '#86efac'; el.style.fontStyle = 'normal'; }
        else if (state === 'error') { el.style.color = '#fca5a5'; el.style.fontStyle = 'normal'; }
        else { el.style.color = '#93c5fd'; el.style.fontStyle = 'normal'; }
    }

    function autoRefresh() {
        const currentShift = inferShift();
        if (siteUsesShiftSelector() && !selectedShift && lastAutoShift && lastAutoShift !== currentShift) {
            selectedDate = null;
            const datePicker = document.getElementById('lhqv-date-picker');
            if (datePicker) { datePicker.value = todayStr(); datePicker.max = todayStr(); }
            updateHeaderBadges();
        }
        lastAutoShift = currentShift;
        const datePicker = document.getElementById('lhqv-date-picker');
        if (datePicker) datePicker.max = todayStr();
        refreshData();
    }

    function updateHeaderBadges() {
        const siteBadge = document.getElementById('lhqv-site-badge');
        const shiftBadge = document.getElementById('lhqv-shift-badge');
        const weekBadge = document.getElementById('lhqv-week-badge');
        const shiftSelect = document.getElementById('lhqv-shift-select');
        const siteSelect = document.getElementById('lhqv-site-select');
        if (siteBadge) siteBadge.textContent = selectedSite;
        if (siteSelect) siteSelect.value = selectedSite;
        if (shiftBadge) {
            const effectiveShift = getEffectiveShift();
            shiftBadge.textContent = effectiveShift === 'DAY' ? 'DAY' : (effectiveShift === 'NIGHT' ? 'NIGHT' : 'EOS');
            shiftBadge.className = 'lhqv-badge ' + (effectiveShift === 'DAY' ? 'day' : 'night');
        }
        if (weekBadge) {
            if (selectedViewMode === 'WEEK') {
                weekBadge.textContent = getWeekLabelText();
                if (selectedSite === 'LCY8') weekBadge.title = 'Loading Day + Night shifts for LCY8';
            } else {
                const baseDate = selectedDate ? new Date(selectedDate + 'T12:00:00') : getOperationalNowBaseDate();
                weekBadge.textContent = 'Week ' + getWeekNumber(baseDate);
            }
        }
        if (shiftSelect) {
            // In LCY8 week view, shift selector is disabled (both shifts load automatically)
            shiftSelect.disabled = !siteUsesShiftSelector() || selectedViewMode === 'WEEK';
            shiftSelect.style.opacity = shiftSelect.disabled ? '0.45' : '1';
            shiftSelect.title = (selectedSite === 'LCY8' && selectedViewMode === 'WEEK')
                ? 'Both Day and Night are loaded automatically in LCY8 Week View'
                : '';
        }
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
<style>
#lhqv-launcher {
    position: fixed; top: 16px; right: 16px; width: 52px; height: 52px;
    border: none; border-radius: 14px;
    background: linear-gradient(145deg, #38bdf8, #2563eb);
    color: #fff; font-size: 22px; cursor: pointer; z-index: 999999;
    box-shadow: 0 8px 24px rgba(37,99,235,0.45);
    display: flex; align-items: center; justify-content: center;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
}
#lhqv-launcher:hover { transform: scale(1.08); box-shadow: 0 12px 32px rgba(37,99,235,0.6); }
#lhqv-overlay {
    position: fixed; inset: 0;
    background: rgba(2,6,23,0.78); backdrop-filter: blur(12px);
    z-index: 999998; display: none; padding: 10px; box-sizing: border-box;
}
#lhqv-overlay.open { display: flex; }
#lhqv-shell {
    width: 100%; height: 100%; display: flex; flex-direction: column;
    background: linear-gradient(160deg, rgba(15,23,42,0.98), rgba(2,6,23,0.99));
    color: #e5eefc; font-family: Inter, system-ui, Arial, sans-serif;
    border: 1px solid rgba(148,163,184,0.15); border-radius: 20px;
    box-shadow: 0 24px 60px rgba(0,0,0,0.55); overflow: hidden;
}

/* \u2500\u2500 HEADER \u2500\u2500 */
#lhqv-header {
    padding: 14px 18px 12px;
    border-bottom: 1px solid rgba(148,163,184,0.10);
    background: rgba(15,23,42,0.92);
    flex-shrink: 0;
}
#lhqv-header-top {
    display: flex; align-items: center; justify-content: space-between;
    flex-wrap: wrap; gap: 8px; margin-bottom: 12px;
}
#lhqv-title {
    margin: 0; font-size: clamp(16px, 1.8vw, 22px); font-weight: 800;
    color: #f8fafc; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
#lhqv-header-badges { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

/* Controls: left group + right group */
#lhqv-controls {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
#lhqv-controls-left { display: flex; gap: 8px; flex-wrap: wrap; flex: 1; }
#lhqv-controls-right { display: flex; gap: 6px; flex-wrap: wrap; }

#lhqv-controls select,
#lhqv-controls input[type="date"] {
    height: 36px; background: rgba(15,23,42,0.88); color: #e2e8f0;
    border: 1px solid rgba(96,165,250,0.3); border-radius: 10px;
    padding: 0 10px; font-size: 12px; box-sizing: border-box; cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
}
#lhqv-controls select:hover, #lhqv-controls input[type="date"]:hover {
    border-color: rgba(56,189,248,0.65); background: rgba(30,41,59,0.95);
}
.lhqv-btn {
    height: 36px; padding: 0 14px; border: none; border-radius: 10px;
    font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap;
    transition: opacity 0.15s, transform 0.1s;
}
.lhqv-btn:hover { opacity: 0.85; transform: translateY(-1px); }
.lhqv-btn:active { transform: translateY(0); }
.lhqv-btn-primary { background: linear-gradient(135deg,#38bdf8,#2563eb); color: #fff; }
.lhqv-btn-secondary { background: rgba(51,65,85,0.9); color: #cbd5e1; border: 1px solid rgba(148,163,184,0.18); }
.lhqv-btn-danger { background: rgba(127,29,29,0.6); color: #fca5a5; border: 1px solid rgba(239,68,68,0.25); }

#lhqv-status-bar {
    margin-top: 10px; padding: 6px 10px;
    background: rgba(2,6,23,0.6); border-radius: 8px;
    font-size: 11px; font-weight: 600; color: #93c5fd;
    border: 1px solid rgba(148,163,184,0.08);
    transition: color 0.3s;
}

/* \u2500\u2500 CARDS \u2500\u2500 */
#lhqv-cards {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 10px; padding: 12px 16px;
    background: rgba(2,6,23,0.5); border-bottom: 1px solid rgba(148,163,184,0.08);
    flex-shrink: 0;
}
.lhqv-card {
    background: rgba(15,23,42,0.9); border-radius: 14px; padding: 12px 14px;
    border-left: 3px solid transparent; min-width: 0;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    transition: transform 0.15s;
}
.lhqv-card:hover { transform: translateY(-2px); }
.lhqv-card:nth-child(1) { border-left-color: #22c55e; }
.lhqv-card:nth-child(2) { border-left-color: #38bdf8; }
.lhqv-card:nth-child(3) { border-left-color: #f59e0b; }
.lhqv-card:nth-child(4) { border-left-color: #a78bfa; }
.lhqv-card-label {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
    color: #64748b; margin-bottom: 5px; font-weight: 700;
}
.lhqv-card-value {
    font-size: clamp(18px, 1.8vw, 26px); font-weight: 800;
    color: #f8fafc; line-height: 1.1; word-break: break-word;
}
.lhqv-card-sub { margin-top: 4px; font-size: 11px; color: #94a3b8; }
#lhqv-bar-wrap {
    margin-top: 8px; display: flex; gap: 4px; height: 6px; width: 100%; border-radius: 999px; overflow: hidden;
}
.lhqv-bar-segment { height: 100%; min-width: 6px; transition: width 0.4s ease; }

/* \u2500\u2500 SEARCH \u2500\u2500 */
#lhqv-search-wrap {
    padding: 10px 14px; background: rgba(2,6,23,0.45);
    border-bottom: 1px solid rgba(148,163,184,0.08); flex-shrink: 0;
    position: relative;
}
#lhqv-search {
    width: 100%; padding: 10px 38px 10px 14px;
    background: rgba(15,23,42,0.92); border: 1px solid rgba(148,163,184,0.14);
    border-radius: 10px; color: #f8fafc; font-size: 13px; box-sizing: border-box;
    transition: border-color 0.15s, box-shadow 0.15s;
}
#lhqv-search:focus { outline: none; border-color: rgba(56,189,248,0.75); box-shadow: 0 0 0 3px rgba(56,189,248,0.10); }
#lhqv-search-clear {
    position: absolute; right: 24px; top: 50%; transform: translateY(-50%);
    background: none; border: none; color: #64748b; font-size: 16px; cursor: pointer;
    display: none; line-height: 1; padding: 2px 4px;
}
#lhqv-search-clear:hover { color: #f8fafc; }

/* \u2500\u2500 TABLE \u2500\u2500 */
#lhqv-table-wrap { flex: 1; overflow: auto; padding: 10px 12px; min-height: 0; }
#lhqv-table { width: 100%; border-collapse: separate; border-spacing: 0 6px; }
#lhqv-table thead th {
    position: sticky; top: 0; z-index: 2; background: rgba(2,6,23,0.98);
    padding: 9px 12px; text-align: left; font-size: 10px;
    text-transform: uppercase; letter-spacing: 0.07em; color: #475569; user-select: none;
}
#lhqv-table tbody td {
    padding: 11px 12px; font-size: 12px; color: #e2e8f0;
    border-top: 1px solid rgba(148,163,184,0.07);
    border-bottom: 1px solid rgba(148,163,184,0.07);
    background: rgba(15,23,42,0.75); vertical-align: middle;
    transition: background 0.12s ease;
}
#lhqv-table tbody tr:hover td { background: rgba(30,41,59,0.95); }
#lhqv-table tbody td:first-child { border-left: 1px solid rgba(148,163,184,0.07); border-radius: 10px 0 0 10px; }
#lhqv-table tbody td:last-child { border-right: 1px solid rgba(148,163,184,0.07); border-radius: 0 10px 10px 0; }
.lhqv-category-row td { background: rgba(34,197,94,0.10) !important; font-weight: 900; cursor: pointer; }
.lhqv-category-row:hover td { background: rgba(34,197,94,0.18) !important; }
.lhqv-subcategory-row td { background: rgba(14,165,233,0.09) !important; font-weight: 800; cursor: pointer; }
.lhqv-subcategory-row:hover td { background: rgba(14,165,233,0.16) !important; }
.lhqv-process-row td { background: rgba(168,85,247,0.09) !important; font-weight: 800; cursor: pointer; }
.lhqv-process-row:hover td { background: rgba(168,85,247,0.16) !important; }
.lhqv-breakout-row td { background: rgba(245,158,11,0.09) !important; font-weight: 700; cursor: pointer; }
.lhqv-breakout-row:hover td { background: rgba(245,158,11,0.16) !important; }
.lhqv-group-title { display: flex; align-items: center; gap: 8px; }
.lhqv-chevron { width: 16px; display: inline-block; color: #475569; font-size: 11px; flex-shrink: 0; }
.lhqv-category-title { font-size: 13px; }
.lhqv-subcategory-title { padding-left: 16px; }
.lhqv-process-title { padding-left: 32px; }
.lhqv-breakout-title { padding-left: 52px; }
.lhqv-group-meta { color: #475569; font-weight: 600; font-size: 11px; }
.lhqv-worker-name { padding-left: 72px !important; font-weight: 700; color: #f8fafc; }
.lhqv-worker-sub { color: #64748b; font-size: 11px; margin-top: 2px; }
.lhqv-hours { font-weight: 800; color: #38bdf8; font-variant-numeric: tabular-nums; }

/* \u2500\u2500 SUMMARY BAR \u2500\u2500 */
#lhqv-summary-bar {
    padding: 8px 16px; background: rgba(2,6,23,0.96);
    border-top: 1px solid rgba(148,163,184,0.08);
    font-size: 11px; flex-shrink: 0;
    display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
}

/* \u2500\u2500 BADGES \u2500\u2500 */
.lhqv-badge {
    display: inline-flex; align-items: center; justify-content: center;
    padding: 2px 9px; border-radius: 999px; font-size: 10px; font-weight: 800;
}
#lhqv-site-badge { background: rgba(168,85,247,0.14); color: #d8b4fe; border: 1px solid rgba(168,85,247,0.25); }
#lhqv-week-badge { background: rgba(34,197,94,0.14); color: #86efac; border: 1px solid rgba(34,197,94,0.22); }
#lhqv-shift-badge.day { background: rgba(251,191,36,0.14); color: #fde68a; border: 1px solid rgba(251,191,36,0.25); }
#lhqv-shift-badge.night { background: rgba(96,165,250,0.14); color: #93c5fd; border: 1px solid rgba(96,165,250,0.25); }

@media (max-width: 800px) {
    #lhqv-overlay { padding: 4px; }
    #lhqv-shell { border-radius: 12px; }
    #lhqv-controls { flex-direction: column; align-items: stretch; }
    #lhqv-controls-right { justify-content: flex-end; }
}
</style>

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
            </div>
            <div id="lhqv-controls-right">
                <button class="lhqv-btn lhqv-btn-primary" id="lhqv-refresh-btn">&#8635; Refresh</button>
                <button class="lhqv-btn lhqv-btn-secondary" id="lhqv-export-btn">&#8595; Export CSV</button>
                <button class="lhqv-btn lhqv-btn-danger" id="lhqv-close-btn">&#10005; Close</button>
            </div>
        </div>
        <div id="lhqv-status-bar" id="lhqv-status">Starting...</div>
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
            <thead>
                <tr>
                    <th>Category / Associate</th>
                    <th>Manager</th>
                    <th>Count / Detail</th>
                    <th>Total Hours</th>
                </tr>
            </thead>
            <tbody id="lhqv-table-body"></tbody>
        </table>
    </div>
    <div id="lhqv-summary-bar"></div>
</div>
`;

        document.body.appendChild(launcher);
        document.body.appendChild(overlay);

        launcher.addEventListener('click', function () { setDashboardOpen(true); });
        overlay.addEventListener('click', function (e) { if (e.target === overlay) setDashboardOpen(false); });
        document.getElementById('lhqv-close-btn').addEventListener('click', function () { setDashboardOpen(false); });

        // Site select
        const siteSelect = document.getElementById('lhqv-site-select');
        AVAILABLE_SITES.forEach(function (site) {
            const opt = document.createElement('option');
            opt.value = site; opt.textContent = site;
            siteSelect.appendChild(opt);
        });
        siteSelect.value = selectedSite;
        siteSelect.addEventListener('change', function () {
            selectedSite = this.value;
            if (!siteUsesShiftSelector()) selectedShift = null;
            populateShiftSelect(); updateHeaderBadges(); refreshData();
        });

        // Date picker
        const datePicker = document.getElementById('lhqv-date-picker');
        datePicker.value = todayStr(); datePicker.max = todayStr();
        datePicker.addEventListener('change', function () { selectedDate = this.value || null; refreshData(); });

        // View mode
        const viewMode = document.getElementById('lhqv-view-mode');
        viewMode.value = selectedViewMode;
        viewMode.addEventListener('change', function () { selectedViewMode = this.value; updateHeaderBadges(); refreshData(); });

        // Shift select
        populateShiftSelect();
        document.getElementById('lhqv-shift-select').addEventListener('change', function () {
            selectedShift = this.value || null; updateHeaderBadges(); refreshData();
        });

        // Buttons
        document.getElementById('lhqv-refresh-btn').addEventListener('click', function () { refreshData(); });
        document.getElementById('lhqv-export-btn').addEventListener('click', function () { exportCSV(); });

        // Search + clear button
        const searchInput = document.getElementById('lhqv-search');
        const clearBtn = document.getElementById('lhqv-search-clear');
        let searchTimer = null;
        searchInput.addEventListener('input', function () {
            clearTimeout(searchTimer);
            clearBtn.style.display = this.value ? 'block' : 'none';
            searchTimer = setTimeout(function () { renderTable(); }, 150);
        });
        clearBtn.addEventListener('click', function () {
            searchInput.value = ''; clearBtn.style.display = 'none'; renderTable();
        });

        // Keyboard shortcut
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && isDashboardOpen) setDashboardOpen(false);
        });

        updateHeaderBadges();
        setDashboardOpen(false);
    }

    createDashboard();
    lastAutoShift = inferShift();
    refreshData();
    resetRefreshTimer();

})();
