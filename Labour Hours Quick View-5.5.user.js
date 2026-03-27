// ==UserScript==
// @name         Labour Hours Quick View
// @namespace    http://tampermonkey.net/
// @version      5.5
// @description  Multi-site labour hours dashboard with full-screen layout, CSV export, site-specific shift windows, EOS-style breakout groups, day/week view, and filtered JOB_ROLE tracking
// @author       brdlnx
// @match        https://fclm-portal.amazon.com/*warehouseId=LCY8*
// @match        https://fclm-portal.amazon.com/*warehouseId=STN8*
// @match        https://fclm-portal.amazon.com/*warehouseId=SXW2*
// @match        https://fclm-portal.amazon.com/*warehouseId=SBS2*
// @grant        GM_xmlhttpRequest
// @connect      fclm-portal.amazon.com
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
                DAY:   { label: 'Day (08:30–19:00)',   startHour: 8,  startMinute: 30, endHour: 19, endMinute: 0,  crossesMidnight: false },
                NIGHT: { label: 'Night (19:00–04:30)', startHour: 19, startMinute: 0,  endHour: 4,  endMinute: 30, crossesMidnight: true  }
            },
            defaultShift: 'DAY',
            hasShiftSelector: true
        },
        STN8: {
            shifts: {
                EOS: { label: 'EOS (07:00–06:00)', startHour: 8, startMinute: 30, endHour: 6, endMinute: 0, crossesMidnight: true }
            },
            defaultShift: 'EOS',
            hasShiftSelector: false
        },
        SBS2: {
            shifts: {
                EOS: { label: 'EOS (14:30–06:00)', startHour: 14, startMinute: 30, endHour: 6, endMinute: 0, crossesMidnight: true }
            },
            defaultShift: 'EOS',
            hasShiftSelector: false
        },
        SXW2: {
            shifts: {
                EOS: { label: 'EOS (11:00–06:00)', startHour: 11, startMinute: 0, endHour: 6, endMinute: 0, crossesMidnight: true }
            },
            defaultShift: 'EOS',
            hasShiftSelector: false
        }
    };

    const TRACKED_PROCESSES = {
        "SC Training": {
            processId: 100391,
            label: 'SC Training [100391]'
        },
        "Admin/HR": {
            processId: 100200,
            label: 'Admin/HR [100200]',
            filter: {
                attribute: 'JOB_ROLE',
                values: ['LN_FC_TRAING_EVENTS', 'LN_TDRCLASSRM_TRAING']
            }
        },
        "Learning Ambassadors": {
            processId: 100384,
            label: 'Learning Ambassadors [100384]'
        },
        "Day 1 and 2 Insturctors": {
            processId: 100385,
            label: 'New Hires [100385]',
            filter: {
                attribute: 'JOB_ROLE',
                values: ['AMB NEW HIRE TRAINING']
            }
        },
        "Day 1": {
            processId: 100243,
            label: 'On Boarding [100243]'
        },
        "Day 2": {
            processId: 100385,
            label: 'New Hires [100385]',
            filter: {
                attribute: 'JOB_ROLE',
                values: ['NEW HIRE TRAINING']
            }
        }
    };

    const CATEGORY_TREE = [
        {
            name: 'Training Hours',
            flat: true,
            processKeys: ['SC Training', 'Admin/HR']
        },
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

    function getSiteConfig() {
        return SITE_WINDOWS[selectedSite] || SITE_WINDOWS[DEFAULT_SITE];
    }

    function getAvailableShifts() {
        return getSiteConfig().shifts;
    }

    function getDefaultShiftForSite() {
        return getSiteConfig().defaultShift;
    }

    function siteUsesShiftSelector() {
        return !!getSiteConfig().hasShiftSelector;
    }

    function getEffectiveShift() {
        const shifts = getAvailableShifts();
        if (selectedShift && shifts[selectedShift]) return selectedShift;
        return getDefaultShiftForSite();
    }

    function getShiftWindow(shiftKey) {
        const shifts = getAvailableShifts();
        return shifts[shiftKey] || shifts[getDefaultShiftForSite()];
    }

    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    function fmtYMD(d) {
        return d.getFullYear() + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate());
    }

    function fmtISODate(d) {
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    function addDays(d, n) {
        const t = new Date(d);
        t.setDate(t.getDate() + n);
        return t;
    }

    function todayStr() {
        return fmtISODate(new Date());
    }

    function inferShift() {
        const shifts = getAvailableShifts();

        if (!siteUsesShiftSelector()) {
            return getDefaultShiftForSite();
        }

        if (selectedShift && shifts[selectedShift]) return selectedShift;

        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const keys = Object.keys(shifts);

        for (let i = 0; i < keys.length; i++) {
            const win = shifts[keys[i]];
            const start = new Date(today);
            start.setHours(win.startHour, win.startMinute, 0, 0);

            const end = new Date(today);
            if (win.crossesMidnight) end.setDate(end.getDate() + 1);
            end.setHours(win.endHour, win.endMinute, 0, 0);

            if (now >= start && now <= end) return keys[i];

            if (win.crossesMidnight) {
                const yStart = addDays(start, -1);
                const yEnd = addDays(end, -1);
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
            const h = base.getHours();
            const m = base.getMinutes();
            if (h < win.endHour || (h === win.endHour && m <= win.endMinute)) {
                base = addDays(base, -1);
            }
        }

        return new Date(base.getFullYear(), base.getMonth(), base.getDate());
    }

    function getWeekStart(dateLike) {
        const d = new Date(dateLike);
        const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        return addDays(dayStart, -dayStart.getDay());
    }

    function getWeekNumber(dateLike) {
        const baseDate = new Date(dateLike);
        const thisWeekStart = getWeekStart(baseDate);
        const week1Start = new Date(
            WEEK_1_START.getFullYear(),
            WEEK_1_START.getMonth(),
            WEEK_1_START.getDate()
        );
        const diffMs = thisWeekStart - week1Start;
        const diffDays = Math.floor(diffMs / 86400000);
        return Math.floor(diffDays / 7) + 1;
    }

    function getWeekDatesForSelectedContext() {
        const baseDate = selectedDate ? new Date(selectedDate + 'T12:00:00') : getOperationalNowBaseDate();
        const weekStart = getWeekStart(baseDate);
        const dates = [];

        for (let i = 0; i < 7; i++) {
            dates.push(addDays(weekStart, i));
        }

        return dates;
    }

    function getWeekLabelText() {
        const baseDate = selectedDate ? new Date(selectedDate + 'T12:00:00') : getOperationalNowBaseDate();
        const weekNo = getWeekNumber(baseDate);
        const weekStart = getWeekStart(baseDate);
        const weekEnd = addDays(weekStart, 6);
        return 'Week ' + weekNo + ' · ' + fmtISODate(weekStart) + ' to ' + fmtISODate(weekEnd);
    }

    function getCacheKey() {
        const dateKey = selectedDate || todayStr();
        const shiftKey = getEffectiveShift();
        return selectedSite + '|' + selectedViewMode + '|' + dateKey + '|' + shiftKey;
    }

    function isHistorical() {
        return selectedDate && selectedDate !== todayStr();
    }

    function resetRefreshTimer() {
        if (refreshTimerId) clearInterval(refreshTimerId);
        refreshTimerId = setInterval(autoRefresh, REFRESH_INTERVAL);
    }

    function buildPPAUrl(processConfig, forcedDateStr, forcedShiftKey) {
        let base = forcedDateStr ? new Date(forcedDateStr + 'T12:00:00') : (selectedDate ? new Date(selectedDate + 'T12:00:00') : new Date());
        const shiftKey = forcedShiftKey || getEffectiveShift();
        const win = getShiftWindow(shiftKey);

        if (!forcedDateStr && !selectedDate && win.crossesMidnight) {
            const h = base.getHours();
            const m = base.getMinutes();
            if (h < win.endHour || (h === win.endHour && m <= win.endMinute)) {
                base = addDays(base, -1);
            }
        }

        const startDate = new Date(base.getFullYear(), base.getMonth(), base.getDate());
        const endDate = win.crossesMidnight ? addDays(startDate, 1) : startDate;

        return 'https://fclm-portal.amazon.com/ppa/inspect/process'
            + '?nodeType=' + NODE_TYPE
            + '&warehouseId=' + selectedSite
            + '&processId=' + processConfig.processId
            + '&primaryAttribute=JOB_ROLE'
            + '&secondaryAttribute=JOB_ROLE'
            + '&spanType=Intraday'
            + '&startDateDay=' + encodeURIComponent(fmtYMD(startDate))
            + '&startDateIntraday=' + encodeURIComponent(fmtYMD(startDate))
            + '&startHourIntraday=' + win.startHour
            + '&startMinuteIntraday=' + win.startMinute
            + '&endDateIntraday=' + encodeURIComponent(fmtYMD(endDate))
            + '&endHourIntraday=' + win.endHour
            + '&endMinuteIntraday=' + win.endMinute
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
            if (depth === 0) {
                try {
                    return JSON.parse(html.substring(startIdx, i + 1));
                } catch (e) {
                    return null;
                }
            }
        }

        return null;
    }

    function getCandidateValues(processAttributes, attributeName) {
        const out = [];
        const targetKey = String(attributeName).toLowerCase();

        if (processAttributes && processAttributes[attributeName] != null) {
            out.push(String(processAttributes[attributeName]).trim());
        }

        for (const key in processAttributes || {}) {
            if (String(key).toLowerCase() === targetKey && processAttributes[key] != null) {
                out.push(String(processAttributes[key]).trim());
            }
        }

        const nested = (processAttributes && processAttributes.attributes) || {};

        if (nested[attributeName] != null) {
            out.push(String(nested[attributeName]).trim());
        }

        for (const key in nested) {
            if (String(key).toLowerCase() === targetKey && nested[key] != null) {
                out.push(String(nested[key]).trim());
            }
        }

        return Array.from(new Set(out.filter(Boolean)));
    }

    function valueMatchesFilter(processAttributes, filter) {
        if (!filter) return true;

        const wantedValues = (filter.values || (filter.value ? [filter.value] : [])).map(function (v) {
            return String(v).trim();
        });

        if (wantedValues.length === 0) return true;

        const candidates = getCandidateValues(processAttributes, filter.attribute);

        return candidates.some(function (candidate) {
            return wantedValues.includes(candidate);
        });
    }

    function getBreakoutValue(processAttributes, processConfig) {
        if (!processAttributes) return 'UNSPECIFIED';
        const attrName = processConfig && processConfig.breakoutAttribute ? processConfig.breakoutAttribute : 'JOB_ROLE';
        const candidates = getCandidateValues(processAttributes, attrName);
        return candidates[0] || 'UNSPECIFIED';
    }

    function aggregateData(productivityList, processLabel, processConfig) {
        if (!rates[processLabel]) {
            rates[processLabel] = {
                workers: {},
                breakouts: {}
            };
        }

        const store = rates[processLabel];
        const filter = processConfig && processConfig.filter ? processConfig.filter : null;

        for (let i = 0; i < productivityList.length; i++) {
            const entry = productivityList[i];
            const processAttributes = entry.processAttributes || {};

            if (filter && !valueMatchesFilter(processAttributes, filter)) {
                continue;
            }

            const trackingType = processAttributes.laborTrackingType || '';
            const associates = entry.associateProductivityList || [];
            const breakoutValue = getBreakoutValue(processAttributes, processConfig);

            if (!store.breakouts[breakoutValue]) {
                store.breakouts[breakoutValue] = {
                    name: breakoutValue,
                    workers: {}
                };
            }

            const seen = {};

            for (let j = 0; j < associates.length; j++) {
                const a = associates[j];
                const empId = a.employeeId;
                const name = a.employeeName || '';
                const managerName = a.managerName || '';

                if (!empId) continue;
                if (seen[empId]) continue;
                seen[empId] = true;

                const rawTime = Number(a.timeMillis || a.timeSeconds || 0);
                const hours = rawTime / 3600;

                if (!store.workers[empId]) {
                    store.workers[empId] = {
                        employeeId: empId,
                        employeeName: name,
                        managerName: managerName,
                        totalDirect: 0,
                        totalIndirect: 0,
                        totalHrs: 0
                    };
                }

                if (!store.breakouts[breakoutValue].workers[empId]) {
                    store.breakouts[breakoutValue].workers[empId] = {
                        employeeId: empId,
                        employeeName: name,
                        managerName: managerName,
                        totalDirect: 0,
                        totalIndirect: 0,
                        totalHrs: 0
                    };
                }

                const workerRec = store.workers[empId];
                const breakoutWorkerRec = store.breakouts[breakoutValue].workers[empId];

                if (trackingType === 'direct') {
                    workerRec.totalDirect += hours;
                    breakoutWorkerRec.totalDirect += hours;
                } else {
                    workerRec.totalIndirect += hours;
                    breakoutWorkerRec.totalIndirect += hours;
                }

                workerRec.totalHrs = workerRec.totalDirect + workerRec.totalIndirect;
                breakoutWorkerRec.totalHrs = breakoutWorkerRec.totalDirect + breakoutWorkerRec.totalIndirect;
            }
        }
    }

    function loadProcess(processLabel, processConfig, onDone, thisGen, forcedDateStr, forcedShiftKey) {
        const url = buildPPAUrl(processConfig, forcedDateStr, forcedShiftKey);

        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            timeout: 15000,
            onload: function (response) {
                if (thisGen !== refreshGeneration) return;

                if (response.status >= 200 && response.status < 300) {
                    const list = extractProductivityList(response.responseText);
                    if (list) aggregateData(list, processLabel, processConfig);
                    onDone(processLabel, !!list);
                } else {
                    onDone(processLabel, false);
                }
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
            for (const key in cached) {
                rates[key] = JSON.parse(JSON.stringify(cached[key]));
            }

            lastRefresh = new Date();
            updateHeaderBadges();
            updateStatus('Loaded from cache · ' + selectedSite + ' · ' + (selectedViewMode === 'WEEK' ? getWeekLabelText() : ((selectedDate || 'Today') + ' · ' + getShiftWindow(getEffectiveShift()).label)));
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
                workItems.push({
                    label: entry[0],
                    config: entry[1],
                    dateStr: forcedDateStr,
                    shiftKey: forcedShiftKey
                });
            });
        } else {
            const weekDates = getWeekDatesForSelectedContext();
            totalToLoad = entries.length * weekDates.length;

            weekDates.forEach(function (dateObj) {
                const dateStr = fmtISODate(dateObj);
                entries.forEach(function (entry) {
                    workItems.push({
                        label: entry[0],
                        config: entry[1],
                        dateStr: dateStr,
                        shiftKey: getEffectiveShift()
                    });
                });
            });
        }

        loadedCount = 0;
        updateStatus('Loading 0/' + totalToLoad + '...');

        function onProcessDone(lbl, success) {
            if (thisGeneration !== refreshGeneration) return;

            if (!success) failedProcesses.push(lbl);
            loadedCount++;

            updateStatus('Loading ' + loadedCount + '/' + totalToLoad + '...');
            renderTable();

            if (loadedCount >= totalToLoad) {
                lastRefresh = new Date();
                updateHeaderBadges();

                let statusMsg;
                if (selectedViewMode === 'WEEK') {
                    statusMsg = 'Loaded · ' + selectedSite + ' · ' + getWeekLabelText() + ' · ' + lastRefresh.toLocaleTimeString();
                } else {
                    const dateLabel = selectedDate || 'Today';
                    const shiftLabel = getShiftWindow(getEffectiveShift()).label;
                    statusMsg = 'Loaded · ' + selectedSite + ' · ' + dateLabel + ' · ' + shiftLabel + ' · ' + lastRefresh.toLocaleTimeString();
                }

                if (failedProcesses.length > 0) {
                    statusMsg += ' · ' + failedProcesses.length + ' failed';
                }

                updateStatus(statusMsg);

                if (isHistorical()) {
                    dataCache[cacheKey] = {};
                    for (const k in rates) {
                        dataCache[cacheKey][k] = JSON.parse(JSON.stringify(rates[k]));
                    }
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

            if (end < workItems.length) {
                setTimeout(function () { launchBatch(end); }, BATCH_DELAY);
            }
        }

        launchBatch(0);
        resetRefreshTimer();
    }

    function normaliseProcessData(procKey) {
        const procData = rates[procKey] || { workers: {}, breakouts: {} };

        const workers = Object.values(procData.workers || {}).sort(function (a, b) {
            return b.totalHrs - a.totalHrs;
        });

        const breakouts = Object.keys(procData.breakouts || {}).map(function (breakoutName) {
            const breakout = procData.breakouts[breakoutName];
            const breakoutWorkers = Object.values(breakout.workers || {}).sort(function (a, b) {
                return b.totalHrs - a.totalHrs;
            });

            return {
                name: breakoutName,
                associates: breakoutWorkers.length,
                totalHrs: breakoutWorkers.reduce(function (sum, worker) { return sum + worker.totalHrs; }, 0),
                workers: breakoutWorkers
            };
        }).sort(function (a, b) {
            if (b.totalHrs !== a.totalHrs) return b.totalHrs - a.totalHrs;
            return a.name.localeCompare(b.name);
        });

        return {
            processKey: procKey,
            processLabel: TRACKED_PROCESSES[procKey].label || procKey,
            associates: workers.length,
            totalHrs: workers.reduce(function (sum, worker) { return sum + worker.totalHrs; }, 0),
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
                if (!workersMap[r.employeeId]) {
                    workersMap[r.employeeId] = {
                        id: r.employeeId,
                        name: r.employeeName,
                        manager: r.managerName,
                        totalHrs: 0,
                        processes: []
                    };
                }

                workersMap[r.employeeId].totalHrs += r.totalHrs;
                workersMap[r.employeeId].processes.push(procNorm.processLabel);
                totalHrs += r.totalHrs;
            });
        });

        const workers = Object.values(workersMap).sort(function (a, b) {
            return b.totalHrs - a.totalHrs;
        });

        processBreakdowns.sort(function (a, b) {
            if (b.totalHrs !== a.totalHrs) return b.totalHrs - a.totalHrs;
            return a.processLabel.localeCompare(b.processLabel);
        });

        return {
            workers: workers,
            associates: workers.length,
            totalHrs: totalHrs,
            processBreakdowns: processBreakdowns
        };
    }

    function getGroupedCategoryData() {
        const categories = [];
        let grandAssociates = 0;
        let grandHours = 0;

        CATEGORY_TREE.forEach(function (category) {
            if (category.flat) {
                const flatData = collectWorkersForProcessKeys(category.processKeys);

                grandAssociates += flatData.associates;
                grandHours += flatData.totalHrs;

                categories.push({
                    name: category.name,
                    associates: flatData.associates,
                    totalHrs: flatData.totalHrs,
                    workers: flatData.workers,
                    flat: true,
                    processBreakdowns: flatData.processBreakdowns,
                    children: []
                });
                return;
            }

            const categoryWorkersMap = {};
            let categoryHours = 0;
            const children = [];

            category.children.forEach(function (subCat) {
                const subData = collectWorkersForProcessKeys(subCat.processKeys);

                subData.workers.forEach(function (worker) {
                    if (!categoryWorkersMap[worker.id]) {
                        categoryWorkersMap[worker.id] = {
                            id: worker.id,
                            name: worker.name,
                            manager: worker.manager,
                            totalHrs: 0,
                            processes: []
                        };
                    }

                    categoryWorkersMap[worker.id].totalHrs += worker.totalHrs;
                    categoryWorkersMap[worker.id].processes = categoryWorkersMap[worker.id].processes.concat(worker.processes);
                });

                categoryHours += subData.totalHrs;

                children.push({
                    name: subCat.name,
                    processKeys: subCat.processKeys.slice(),
                    associates: subData.associates,
                    totalHrs: subData.totalHrs,
                    workers: subData.workers,
                    processBreakdowns: subData.processBreakdowns
                });
            });

            const categoryWorkers = Object.values(categoryWorkersMap).sort(function (a, b) {
                return b.totalHrs - a.totalHrs;
            });

            grandAssociates += categoryWorkers.length;
            grandHours += categoryHours;

            categories.push({
                name: category.name,
                associates: categoryWorkers.length,
                totalHrs: categoryHours,
                workers: categoryWorkers,
                flat: false,
                children: children
            });
        });

        return {
            categories: categories,
            totalAssociates: grandAssociates,
            totalHrs: grandHours
        };
    }

    function populateShiftSelect() {
        const shiftSelect = document.getElementById('lhqv-shift-select');
        if (!shiftSelect) return;

        shiftSelect.innerHTML = '';
        const shifts = getAvailableShifts();

        if (siteUsesShiftSelector()) {
            const autoOpt = document.createElement('option');
            autoOpt.value = '';
            autoOpt.textContent = 'Auto Shift';
            shiftSelect.appendChild(autoOpt);

            Object.keys(shifts).forEach(function (shiftKey) {
                const opt = document.createElement('option');
                opt.value = shiftKey;
                opt.textContent = shifts[shiftKey].label;
                shiftSelect.appendChild(opt);
            });

            shiftSelect.value = selectedShift || '';
        } else {
            Object.keys(shifts).forEach(function (shiftKey) {
                const opt = document.createElement('option');
                opt.value = shiftKey;
                opt.textContent = shifts[shiftKey].label;
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
        if (str.includes('"') || str.includes(',') || str.includes('\n')) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

    function buildCSVRows() {
        const rows = [];
        const grouped = getGroupedCategoryData();

        grouped.categories.forEach(function (category) {
            if (category.flat) {
                category.processBreakdowns.forEach(function (processItem) {
                    processItem.breakouts.forEach(function (breakout) {
                        breakout.workers.forEach(function (worker) {
                            rows.push({
                                site: selectedSite,
                                viewMode: selectedViewMode,
                                dateOrWeek: selectedViewMode === 'WEEK' ? getWeekLabelText() : (selectedDate || todayStr()),
                                operationalWindow: getShiftWindow(getEffectiveShift()).label,
                                category: category.name,
                                subCategory: '',
                                process: processItem.processLabel,
                                breakout: breakout.name,
                                employeeId: worker.employeeId,
                                employeeName: worker.employeeName,
                                manager: worker.managerName || '',
                                totalHours: worker.totalHrs.toFixed(2)
                            });
                        });
                    });
                });
            } else {
                category.children.forEach(function (child) {
                    child.processBreakdowns.forEach(function (processItem) {
                        processItem.breakouts.forEach(function (breakout) {
                            breakout.workers.forEach(function (worker) {
                                rows.push({
                                    site: selectedSite,
                                    viewMode: selectedViewMode,
                                    dateOrWeek: selectedViewMode === 'WEEK' ? getWeekLabelText() : (selectedDate || todayStr()),
                                    operationalWindow: getShiftWindow(getEffectiveShift()).label,
                                    category: category.name,
                                    subCategory: child.name,
                                    process: processItem.processLabel,
                                    breakout: breakout.name,
                                    employeeId: worker.employeeId,
                                    employeeName: worker.employeeName,
                                    manager: worker.managerName || '',
                                    totalHours: worker.totalHrs.toFixed(2)
                                });
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

        if (!rows.length) {
            updateStatus('No data to export.');
            return;
        }

        const header = [
            'Site',
            'View Mode',
            'Date/Week',
            'Operational Window',
            'Category',
            'Sub Category',
            'Process',
            'Breakout',
            'Employee ID',
            'Employee Name',
            'Manager',
            'Total Hours'
        ];

        let csv = header.join(',') + '\n';

        rows.forEach(function (row) {
            csv += [
                escapeCSV(row.site),
                escapeCSV(row.viewMode),
                escapeCSV(row.dateOrWeek),
                escapeCSV(row.operationalWindow),
                escapeCSV(row.category),
                escapeCSV(row.subCategory),
                escapeCSV(row.process),
                escapeCSV(row.breakout),
                escapeCSV(row.employeeId),
                escapeCSV(row.employeeName),
                escapeCSV(row.manager),
                escapeCSV(row.totalHours)
            ].join(',') + '\n';
        });

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const now = new Date();

        a.href = url;
        a.download = [
            selectedSite,
            'labour_hours',
            selectedViewMode.toLowerCase(),
            selectedViewMode === 'WEEK'
                ? ('week_' + getWeekNumber(selectedDate ? new Date(selectedDate + 'T12:00:00') : getOperationalNowBaseDate()))
                : (selectedDate || todayStr()),
            now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate()),
            pad2(now.getHours()) + pad2(now.getMinutes())
        ].join('_') + '.csv';

        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        updateStatus('CSV exported.');
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

        const topCategory = grouped.categories.slice().sort(function (a, b) {
            return b.totalHrs - a.totalHrs;
        })[0];

        if (topCategory && topCategory.totalHrs > 0) {
            topCategoryEl.textContent = topCategory.name;
            topCategorySubEl.textContent = topCategory.totalHrs.toFixed(2) + ' hrs · ' + topCategory.associates + ' associates';
        } else {
            topCategoryEl.textContent = '-';
            topCategorySubEl.textContent = 'Waiting for data';
        }

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
                    const filteredWorkers = breakout.workers.filter(function (worker) {
                        return (worker.employeeName || '').toLowerCase().includes(searchTerm)
                            || (worker.managerName || '').toLowerCase().includes(searchTerm);
                    });

                    return Object.assign({}, breakout, {
                        workers: filteredWorkers,
                        associates: filteredWorkers.length,
                        totalHrs: filteredWorkers.reduce(function (sum, worker) { return sum + worker.totalHrs; }, 0)
                    });
                }).filter(function (breakout) {
                    return breakout.workers.length > 0;
                });
            }

            if (!visibleBreakouts.length) return;

            const processKey = parentKeyBase + '||PROC||' + processItem.processKey;
            const processExpanded = !!processState[processKey];
            const processAssocCount = visibleBreakouts.reduce(function (sum, breakout) { return sum + breakout.associates; }, 0);
            const processHours = visibleBreakouts.reduce(function (sum, breakout) { return sum + breakout.totalHrs; }, 0);

            const processRow = document.createElement('tr');
            processRow.className = 'lhqv-process-row';
            processRow.innerHTML = `
                <td>
                    <div class="lhqv-group-title lhqv-process-title">
                        <span class="lhqv-chevron">${processExpanded ? '▼' : '▶'}</span>
                        <span>${processItem.processLabel}</span>
                    </div>
                </td>
                <td><span class="lhqv-group-meta">EOS Process</span></td>
                <td>${processAssocCount} associate${processAssocCount === 1 ? '' : 's'}</td>
                <td class="lhqv-hours">${processHours.toFixed(2)}</td>
            `;
            processRow.addEventListener('click', function (e) {
                e.stopPropagation();
                processState[processKey] = !processExpanded;
                renderTable();
            });
            tbody.appendChild(processRow);

            if (processExpanded) {
                visibleBreakouts.forEach(function (breakout) {
                    const breakoutKey = processKey + '||BR||' + breakout.name;
                    const breakoutExpanded = !!breakoutState[breakoutKey];

                    const breakoutRow = document.createElement('tr');
                    breakoutRow.className = 'lhqv-breakout-row';
                    breakoutRow.innerHTML = `
                        <td>
                            <div class="lhqv-group-title lhqv-breakout-title">
                                <span class="lhqv-chevron">${breakoutExpanded ? '▼' : '▶'}</span>
                                <span>${breakout.name}</span>
                            </div>
                        </td>
                        <td><span class="lhqv-group-meta">JOB_ROLE</span></td>
                        <td>${breakout.associates} associate${breakout.associates === 1 ? '' : 's'}</td>
                        <td class="lhqv-hours">${breakout.totalHrs.toFixed(2)}</td>
                    `;
                    breakoutRow.addEventListener('click', function (e) {
                        e.stopPropagation();
                        breakoutState[breakoutKey] = !breakoutExpanded;
                        renderTable();
                    });
                    tbody.appendChild(breakoutRow);

                    if (breakoutExpanded) {
                        breakout.workers.forEach(function (worker) {
                            const row = document.createElement('tr');
                            row.innerHTML = `
                                <td class="lhqv-worker-name">
                                    ${worker.employeeName}
                                    <div class="lhqv-worker-sub">ID: ${worker.employeeId}</div>
                                </td>
                                <td>${worker.managerName || '-'}</td>
                                <td>${processItem.processLabel}</td>
                                <td class="lhqv-hours">${worker.totalHrs.toFixed(2)}</td>
                            `;
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

        const searchTerm = (document.getElementById('lhqv-search').value || '').toLowerCase().trim();
        const grouped = getGroupedCategoryData();

        renderCards(grouped);
        tbody.innerHTML = '';

        if (!grouped.categories.length) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#64748b;padding:24px;border-radius:12px;">No data yet</td></tr>';
            updateSummary(grouped, searchTerm);
            return;
        }

        let shownAny = false;

        grouped.categories.forEach(function (category) {
            if (category.flat) {
                let visibleWorkers = category.workers;
                let visibleProcesses = category.processBreakdowns;

                if (searchTerm) {
                    visibleWorkers = category.workers.filter(function (worker) {
                        return (worker.name || '').toLowerCase().includes(searchTerm)
                            || (worker.manager || '').toLowerCase().includes(searchTerm);
                    });

                    visibleProcesses = category.processBreakdowns.map(function (proc) {
                        const filteredBreakouts = proc.breakouts.map(function (br) {
                            const filteredWorkers = br.workers.filter(function (worker) {
                                return (worker.employeeName || '').toLowerCase().includes(searchTerm)
                                    || (worker.managerName || '').toLowerCase().includes(searchTerm);
                            });
                            return Object.assign({}, br, {
                                workers: filteredWorkers,
                                associates: filteredWorkers.length,
                                totalHrs: filteredWorkers.reduce(function (sum, worker) { return sum + worker.totalHrs; }, 0)
                            });
                        }).filter(function (br) {
                            return br.workers.length > 0;
                        });

                        return Object.assign({}, proc, { breakouts: filteredBreakouts });
                    }).filter(function (proc) {
                        return proc.breakouts.length > 0;
                    });
                }

                if (!searchTerm || visibleWorkers.length > 0 || visibleProcesses.length > 0) {
                    shownAny = true;

                    const catExpanded = !!categoryState[category.name];
                    const assocCount = searchTerm ? visibleWorkers.length : category.associates;
                    const hours = searchTerm
                        ? visibleWorkers.reduce(function (sum, worker) { return sum + worker.totalHrs; }, 0)
                        : category.totalHrs;

                    const catRow = document.createElement('tr');
                    catRow.className = 'lhqv-category-row';
                    catRow.innerHTML = `
                        <td>
                            <div class="lhqv-group-title lhqv-category-title">
                                <span class="lhqv-chevron">${catExpanded ? '▼' : '▶'}</span>
                                <span>${category.name}</span>
                            </div>
                        </td>
                        <td><span class="lhqv-group-meta">Combined</span></td>
                        <td>${assocCount} associate${assocCount === 1 ? '' : 's'}</td>
                        <td class="lhqv-hours">${hours.toFixed(2)}</td>
                    `;
                    catRow.addEventListener('click', function () {
                        categoryState[category.name] = !catExpanded;
                        renderTable();
                    });
                    tbody.appendChild(catRow);

                    if (catExpanded) {
                        renderProcessBreakdowns(tbody, visibleProcesses, searchTerm, category.name);
                    }
                }

                return;
            }

            let categoryVisible = true;
            let visibleChildren = category.children;

            if (searchTerm) {
                visibleChildren = category.children.map(function (child) {
                    const filteredWorkers = child.workers.filter(function (worker) {
                        return (worker.name || '').toLowerCase().includes(searchTerm)
                            || (worker.manager || '').toLowerCase().includes(searchTerm);
                    });

                    const filteredProcesses = child.processBreakdowns.map(function (proc) {
                        const filteredBreakouts = proc.breakouts.map(function (br) {
                            const filteredWorkersBr = br.workers.filter(function (worker) {
                                return (worker.employeeName || '').toLowerCase().includes(searchTerm)
                                    || (worker.managerName || '').toLowerCase().includes(searchTerm);
                            });

                            return Object.assign({}, br, {
                                workers: filteredWorkersBr,
                                associates: filteredWorkersBr.length,
                                totalHrs: filteredWorkersBr.reduce(function (sum, worker) { return sum + worker.totalHrs; }, 0)
                            });
                        }).filter(function (br) {
                            return br.workers.length > 0;
                        });

                        return Object.assign({}, proc, { breakouts: filteredBreakouts });
                    }).filter(function (proc) {
                        return proc.breakouts.length > 0;
                    });

                    return Object.assign({}, child, {
                        workers: filteredWorkers,
                        associates: filteredWorkers.length,
                        totalHrs: filteredWorkers.reduce(function (s, w) { return s + w.totalHrs; }, 0),
                        processBreakdowns: filteredProcesses
                    });
                }).filter(function (child) {
                    return child.workers.length > 0 || child.processBreakdowns.length > 0;
                });

                categoryVisible = visibleChildren.length > 0;
            }

            if (!categoryVisible) return;
            shownAny = true;

            const catExpanded = !!categoryState[category.name];
            const categoryAssocCount = visibleChildren.reduce(function (sum, child) { return sum + child.associates; }, 0);
            const categoryHours = visibleChildren.reduce(function (sum, child) { return sum + child.totalHrs; }, 0);

            const catRow = document.createElement('tr');
            catRow.className = 'lhqv-category-row';
            catRow.innerHTML = `
                <td>
                    <div class="lhqv-group-title lhqv-category-title">
                        <span class="lhqv-chevron">${catExpanded ? '▼' : '▶'}</span>
                        <span>${category.name}</span>
                    </div>
                </td>
                <td><span class="lhqv-group-meta">Category Total</span></td>
                <td>${categoryAssocCount} associate${categoryAssocCount === 1 ? '' : 's'}</td>
                <td class="lhqv-hours">${categoryHours.toFixed(2)}</td>
            `;
            catRow.addEventListener('click', function () {
                categoryState[category.name] = !catExpanded;
                renderTable();
            });
            tbody.appendChild(catRow);

            if (catExpanded) {
                visibleChildren.forEach(function (child) {
                    const subKey = category.name + '||' + child.name;
                    const subExpanded = !!subCategoryState[subKey];

                    const subRow = document.createElement('tr');
                    subRow.className = 'lhqv-subcategory-row';
                    subRow.innerHTML = `
                        <td>
                            <div class="lhqv-group-title lhqv-subcategory-title">
                                <span class="lhqv-chevron">${subExpanded ? '▼' : '▶'}</span>
                                <span>${child.name}</span>
                            </div>
                        </td>
                        <td><span class="lhqv-group-meta">${child.processKeys.join(', ')}</span></td>
                        <td>${child.associates} associate${child.associates === 1 ? '' : 's'}</td>
                        <td class="lhqv-hours">${child.totalHrs.toFixed(2)}</td>
                    `;
                    subRow.addEventListener('click', function (e) {
                        e.stopPropagation();
                        subCategoryState[subKey] = !subExpanded;
                        renderTable();
                    });
                    tbody.appendChild(subRow);

                    if (subExpanded) {
                        renderProcessBreakdowns(tbody, child.processBreakdowns, searchTerm, subKey);
                    }
                });
            }
        });

        if (!shownAny) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#64748b;padding:24px;border-radius:12px;">No matches found</td></tr>';
        }

        updateSummary(grouped, searchTerm);
    }

    function updateSummary(grouped, searchTerm) {
        const bar = document.getElementById('lhqv-summary-bar');
        if (!bar) return;

        let text = selectedSite + ' | ' + grouped.totalAssociates + ' associates | Total Hours: ' + grouped.totalHrs.toFixed(2);

        const openCats = Object.keys(categoryState).filter(function (k) { return categoryState[k]; }).length;
        const openSubs = Object.keys(subCategoryState).filter(function (k) { return subCategoryState[k]; }).length;
        const openProcesses = Object.keys(processState).filter(function (k) { return processState[k]; }).length;
        const openBreakouts = Object.keys(breakoutState).filter(function (k) { return breakoutState[k]; }).length;

        text += ' | ' + openCats + ' categories open';
        text += ' | ' + openSubs + ' sub-categories open';
        text += ' | ' + openProcesses + ' processes open';
        text += ' | ' + openBreakouts + ' breakouts open';

        if (selectedViewMode === 'WEEK') {
            text += ' | ' + getWeekLabelText();
        }

        if (searchTerm) {
            text += ' | Filter: "' + searchTerm + '"';
        }

        bar.textContent = text;
    }

    function updateStatus(msg) {
        const el = document.getElementById('lhqv-status');
        if (el) el.textContent = msg;
    }

    function autoRefresh() {
        const currentShift = inferShift();

        if (siteUsesShiftSelector() && !selectedShift && lastAutoShift && lastAutoShift !== currentShift) {
            selectedDate = null;
            const datePicker = document.getElementById('lhqv-date-picker');
            if (datePicker) {
                datePicker.value = todayStr();
                datePicker.max = todayStr();
            }
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
            const shiftText = effectiveShift === 'DAY' ? 'DAY' : (effectiveShift === 'NIGHT' ? 'NIGHT' : 'EOS');
            shiftBadge.textContent = shiftText;
            shiftBadge.className = 'lhqv-badge ' + (effectiveShift === 'DAY' ? 'day' : 'night');
        }

        if (weekBadge) {
            if (selectedViewMode === 'WEEK') {
                weekBadge.textContent = getWeekLabelText();
            } else {
                const baseDate = selectedDate ? new Date(selectedDate + 'T12:00:00') : getOperationalNowBaseDate();
                weekBadge.textContent = 'Week ' + getWeekNumber(baseDate);
            }
        }

        if (shiftSelect) {
            shiftSelect.disabled = !siteUsesShiftSelector() || selectedViewMode === 'WEEK';
            shiftSelect.style.opacity = shiftSelect.disabled ? '0.55' : '1';
        }
    }

    function createDashboard() {
        const oldOverlay = document.getElementById('lhqv-overlay');
        if (oldOverlay) oldOverlay.remove();

        const oldLauncher = document.getElementById('lhqv-launcher');
        if (oldLauncher) oldLauncher.remove();

        const launcher = document.createElement('button');
        launcher.id = 'lhqv-launcher';
        launcher.textContent = 'LH';
        launcher.title = 'Open Labour Hours Quick View';

        const overlay = document.createElement('div');
        overlay.id = 'lhqv-overlay';

        overlay.innerHTML = `
<style>
#lhqv-launcher {
    position: fixed;
    top: 16px;
    right: 16px;
    width: 56px;
    height: 56px;
    border: none;
    border-radius: 16px;
    background: linear-gradient(180deg, #38bdf8, #2563eb);
    color: #fff;
    font-weight: 900;
    font-size: 18px;
    cursor: pointer;
    z-index: 999999;
    box-shadow: 0 14px 28px rgba(0,0,0,0.30);
    display: flex;
    align-items: center;
    justify-content: center;
}
#lhqv-launcher:hover {
    background: linear-gradient(180deg, #0ea5e9, #1d4ed8);
}
#lhqv-overlay {
    position: fixed;
    inset: 0;
    background: rgba(2, 6, 23, 0.72);
    backdrop-filter: blur(10px);
    z-index: 999998;
    display: none;
    padding: 12px;
    box-sizing: border-box;
}
#lhqv-overlay.open {
    display: block;
}
#lhqv-shell {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: linear-gradient(180deg, rgba(15,23,42,0.985), rgba(2,6,23,0.985));
    color: #e5eefc;
    font-family: Inter, Arial, sans-serif;
    border: 1px solid rgba(148,163,184,0.18);
    border-radius: 22px;
    box-shadow: 0 18px 50px rgba(0,0,0,0.45);
    overflow: hidden;
}
#lhqv-header {
    padding: 16px;
    border-bottom: 1px solid rgba(148,163,184,0.12);
    background: linear-gradient(180deg, rgba(30,41,59,0.95), rgba(15,23,42,0.75));
    flex-shrink: 0;
}
#lhqv-header h2 {
    margin: 0 0 10px 0;
    font-size: clamp(18px, 2vw, 28px);
    font-weight: 800;
    color: #f8fafc;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}
#lhqv-controls {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 8px;
    align-items: center;
}
#lhqv-controls select,
#lhqv-controls button,
#lhqv-controls input[type="date"] {
    width: 100%;
    min-height: 42px;
    background: rgba(15,23,42,0.85);
    color: #e2e8f0;
    border: 1px solid rgba(96,165,250,0.35);
    border-radius: 12px;
    padding: 8px 10px;
    font-size: 12px;
    box-sizing: border-box;
}
#lhqv-controls button {
    cursor: pointer;
    font-weight: 700;
}
#lhqv-controls button:hover,
#lhqv-controls select:hover {
    border-color: rgba(56,189,248,0.75);
    background: rgba(30,41,59,0.95);
}
#lhqv-status {
    grid-column: 1 / -1;
    font-size: 12px;
    color: #93c5fd;
    font-weight: 600;
    padding-top: 4px;
}
#lhqv-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 10px;
    padding: 14px 16px;
    background: rgba(15,23,42,0.78);
    border-bottom: 1px solid rgba(148,163,184,0.10);
    flex-shrink: 0;
}
.lhqv-card {
    background: rgba(30,41,59,0.85);
    border: 1px solid rgba(148,163,184,0.12);
    border-radius: 16px;
    padding: 12px;
    min-width: 0;
}
.lhqv-card-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #93c5fd;
    margin-bottom: 6px;
    font-weight: 700;
}
.lhqv-card-value {
    font-size: clamp(20px, 2vw, 28px);
    font-weight: 800;
    color: #f8fafc;
    line-height: 1.1;
    word-break: break-word;
}
.lhqv-card-sub {
    margin-top: 6px;
    font-size: 11px;
    color: #94a3b8;
}
#lhqv-bar-wrap {
    margin-top: 8px;
    display: flex;
    gap: 6px;
    height: 10px;
    width: 100%;
}
.lhqv-bar-segment {
    height: 100%;
    border-radius: 999px;
    min-width: 8px;
    opacity: 0.95;
}
#lhqv-search-wrap {
    padding: 12px 14px;
    background: rgba(15,23,42,0.7);
    border-bottom: 1px solid rgba(148,163,184,0.10);
    flex-shrink: 0;
}
#lhqv-search {
    width: 100%;
    padding: 12px 14px;
    background: rgba(15,23,42,0.92);
    border: 1px solid rgba(148,163,184,0.16);
    border-radius: 12px;
    color: #f8fafc;
    font-size: 14px;
    box-sizing: border-box;
}
#lhqv-search:focus {
    outline: none;
    border-color: rgba(56,189,248,0.8);
    box-shadow: 0 0 0 3px rgba(56,189,248,0.12);
}
#lhqv-table-wrap {
    flex: 1;
    overflow: auto;
    padding: 12px;
    min-height: 0;
}
#lhqv-table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0 8px;
}
#lhqv-table thead th {
    position: sticky;
    top: 0;
    z-index: 2;
    background: rgba(2,6,23,0.98);
    padding: 10px 12px;
    text-align: left;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #7dd3fc;
    user-select: none;
}
#lhqv-table tbody td {
    padding: 12px;
    font-size: 12px;
    color: #e2e8f0;
    border-top: 1px solid rgba(148,163,184,0.10);
    border-bottom: 1px solid rgba(148,163,184,0.10);
    background: rgba(30,41,59,0.72);
    vertical-align: top;
}
#lhqv-table tbody tr:hover td {
    background: rgba(51,65,85,0.92);
}
#lhqv-table tbody td:first-child {
    border-left: 1px solid rgba(148,163,184,0.10);
    border-radius: 12px 0 0 12px;
}
#lhqv-table tbody td:last-child {
    border-right: 1px solid rgba(148,163,184,0.10);
    border-radius: 0 12px 12px 0;
}
.lhqv-category-row td {
    background: rgba(34,197,94,0.12) !important;
    font-weight: 900;
    cursor: pointer;
}
.lhqv-category-row:hover td {
    background: rgba(34,197,94,0.20) !important;
}
.lhqv-subcategory-row td {
    background: rgba(14,165,233,0.10) !important;
    font-weight: 800;
    cursor: pointer;
}
.lhqv-subcategory-row:hover td {
    background: rgba(14,165,233,0.18) !important;
}
.lhqv-process-row td {
    background: rgba(168,85,247,0.10) !important;
    font-weight: 800;
    cursor: pointer;
}
.lhqv-process-row:hover td {
    background: rgba(168,85,247,0.18) !important;
}
.lhqv-breakout-row td {
    background: rgba(245,158,11,0.10) !important;
    font-weight: 700;
    cursor: pointer;
}
.lhqv-breakout-row:hover td {
    background: rgba(245,158,11,0.18) !important;
}
.lhqv-group-title {
    display: flex;
    align-items: center;
    gap: 10px;
}
.lhqv-chevron {
    width: 18px;
    display: inline-block;
    color: #7dd3fc;
    font-size: 14px;
    flex-shrink: 0;
}
.lhqv-category-title { font-size: 13px; }
.lhqv-subcategory-title { padding-left: 18px; }
.lhqv-process-title { padding-left: 36px; }
.lhqv-breakout-title { padding-left: 56px; }
.lhqv-group-meta {
    color: #94a3b8;
    font-weight: 600;
    font-size: 11px;
}
.lhqv-worker-name {
    padding-left: 78px !important;
    font-weight: 700;
    color: #f8fafc;
}
.lhqv-worker-sub {
    color: #94a3b8;
    font-size: 11px;
}
.lhqv-hours {
    font-weight: 800;
    color: #7dd3fc;
}
#lhqv-summary-bar {
    padding: 12px 16px;
    background: rgba(2,6,23,0.95);
    border-top: 1px solid rgba(148,163,184,0.10);
    font-size: 12px;
    color: #cbd5e1;
    font-weight: 600;
    flex-shrink: 0;
}
.lhqv-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 800;
}
#lhqv-site-badge {
    background: rgba(168,85,247,0.16);
    color: #d8b4fe;
    border: 1px solid rgba(168,85,247,0.28);
}
#lhqv-week-badge {
    background: rgba(34,197,94,0.16);
    color: #86efac;
    border: 1px solid rgba(34,197,94,0.26);
}
#lhqv-shift-badge.day {
    background: rgba(251,191,36,0.18);
    color: #fde68a;
    border: 1px solid rgba(251,191,36,0.28);
}
#lhqv-shift-badge.night {
    background: rgba(96,165,250,0.18);
    color: #93c5fd;
    border: 1px solid rgba(96,165,250,0.28);
}
@media (max-width: 900px) {
    #lhqv-overlay {
        padding: 6px;
    }
    #lhqv-shell {
        border-radius: 14px;
    }
    #lhqv-table tbody td,
    #lhqv-table thead th {
        padding: 9px;
    }
}
</style>

<div id="lhqv-shell">
    <div id="lhqv-header">
        <h2>
            ⏱ Labour Hours Quick View
            <span id="lhqv-site-badge" class="lhqv-badge"></span>
            <span id="lhqv-shift-badge" class="lhqv-badge"></span>
            <span id="lhqv-week-badge" class="lhqv-badge"></span>
        </h2>
        <div id="lhqv-controls">
            <select id="lhqv-site-select"></select>
            <input type="date" id="lhqv-date-picker" title="Select date (blank = today)" />
            <select id="lhqv-view-mode">
                <option value="DAY">Day View</option>
                <option value="WEEK">Week View</option>
            </select>
            <select id="lhqv-shift-select"></select>
            <button id="lhqv-refresh-btn">Refresh</button>
            <button id="lhqv-export-btn">Export CSV</button>
            <button id="lhqv-close-btn">Close</button>
            <span id="lhqv-status">Starting...</span>
        </div>
    </div>

    <div id="lhqv-cards">
        <div class="lhqv-card">
            <div class="lhqv-card-label">Total Used Labour Hours</div>
            <div class="lhqv-card-value" id="lhqv-total-hrs">0.00</div>
            <div class="lhqv-card-sub">All tracked categories combined</div>
            <div id="lhqv-bar-wrap"></div>
        </div>
        <div class="lhqv-card">
            <div class="lhqv-card-label">Associates</div>
            <div class="lhqv-card-value" id="lhqv-total-associates">0</div>
            <div class="lhqv-card-sub">Unique workers across categories</div>
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
        <input type="text" id="lhqv-search" placeholder="Search by worker or manager..." />
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

        launcher.addEventListener('click', function () {
            setDashboardOpen(true);
        });

        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) setDashboardOpen(false);
        });

        document.getElementById('lhqv-close-btn').addEventListener('click', function () {
            setDashboardOpen(false);
        });

        const siteSelect = document.getElementById('lhqv-site-select');
        AVAILABLE_SITES.forEach(function (site) {
            const opt = document.createElement('option');
            opt.value = site;
            opt.textContent = site;
            siteSelect.appendChild(opt);
        });
        siteSelect.value = selectedSite;
        siteSelect.addEventListener('change', function () {
            selectedSite = this.value;
            if (!siteUsesShiftSelector()) selectedShift = null;
            populateShiftSelect();
            updateHeaderBadges();
            refreshData();
        });

        const datePicker = document.getElementById('lhqv-date-picker');
        datePicker.value = todayStr();
        datePicker.max = todayStr();
        datePicker.addEventListener('change', function () {
            selectedDate = this.value || null;
            refreshData();
        });

        const viewMode = document.getElementById('lhqv-view-mode');
        viewMode.value = selectedViewMode;
        viewMode.addEventListener('change', function () {
            selectedViewMode = this.value;
            updateHeaderBadges();
            refreshData();
        });

        populateShiftSelect();

        document.getElementById('lhqv-shift-select').addEventListener('change', function () {
            selectedShift = this.value || null;
            updateHeaderBadges();
            refreshData();
        });

        document.getElementById('lhqv-refresh-btn').addEventListener('click', function () {
            refreshData();
        });

        document.getElementById('lhqv-export-btn').addEventListener('click', function () {
            exportCSV();
        });

        let searchTimer = null;
        document.getElementById('lhqv-search').addEventListener('input', function () {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(function () {
                renderTable();
            }, 150);
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && isDashboardOpen) {
                setDashboardOpen(false);
            }
        });

        updateHeaderBadges();
        setDashboardOpen(false);
    }

    createDashboard();
    lastAutoShift = inferShift();
    refreshData();
    resetRefreshTimer();

})();
