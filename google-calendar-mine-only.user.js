// ==UserScript==
// @name         Google Calendar - Mine Only / Restore
// @namespace    local.gcal.mine-only
// @version      1.4.0
// @description  Toggle your own calendars, restore visibility, and dim events from other calendars.
// @match        https://calendar.google.com/*
// @grant        none
// @run-at       document-idle
// @license      MIT
// @homepageURL  https://github.com/nielsschroyen/tampermonkey
// @supportURL   https://github.com/nielsschroyen/tampermonkey/issues
// @downloadURL  https://raw.githubusercontent.com/nielsschroyen/tampermonkey/main/google-calendar-mine-only.user.js
// @updateURL    https://raw.githubusercontent.com/nielsschroyen/tampermonkey/main/google-calendar-mine-only.user.js
// ==/UserScript==

(() => {
    'use strict';

    const STORAGE_KEY_PRIMARY = 'gcalMineOnly.primaryCalendars';
    const STORAGE_KEY_STATE = 'gcalMineOnly.previousState';

    const BUTTON_ID = 'gcal-mine-only-toggle';
    const DIM_BUTTON_ID = 'gcal-dim-others-toggle';

    const DIM_CLASS = 'gcal-mine-only-dimmed';
    const DIM_STYLE_ID = 'gcal-mine-only-dim-style';
    const DIM_OPACITY = 0.5;

    let mineOnlyActive = false;
    let dimOthersActive = false;
    let busy = false;
    let dimRefreshTimer = null;

    const sleep = ms =>
        new Promise(resolve => setTimeout(resolve, ms));

    function cleanCalendarName(name) {
        return (name || '')
            .replace(/\s+/g, ' ')
            .replace(/^show\s+/i, '')
            .replace(/^hide\s+/i, '')
            .replace(/^toggle\s+/i, '')
            .replace(/^calendar[:\s-]*/i, '')
            .replace(/\s+calendar$/i, '')
            .trim();
    }

    function isVisible(element) {
        const rect = element.getBoundingClientRect();

        return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.right > 0
        );
    }

    function getCheckedState(element) {
        if (
            element instanceof HTMLInputElement &&
            element.type === 'checkbox'
        ) {
            return element.checked;
        }

        const ariaChecked =
            element.getAttribute('aria-checked');

        if (ariaChecked === 'true') return true;
        if (ariaChecked === 'false') return false;

        return null;
    }

    function looksLikeDateControl(text) {
        if (!text) return false;

        const patterns = [
            /^\d{1,2}\s*,\s*\p{L}+/iu,
            /^\d{1,2}\s+\p{L}+\s*,\s*\p{L}+/iu,
            /^\d{1,2}\s+\p{L}+\s+\d{4}$/iu,
            /^\p{L}+\s+\d{1,2}(?:,\s*\d{4})?$/iu
        ];

        return patterns.some(
            pattern => pattern.test(text)
        );
    }

    function looksLikeUiControl(text) {
        if (!text) return true;

        const rejected = new Set([
            'create',
            'maken',
            'today',
            'vandaag',
            'previous',
            'vorige',
            'next',
            'volgende',
            'search',
            'zoeken',
            'settings',
            'instellingen',
            'support',
            'main menu',
            'hoofdmenu',
            'google apps',
            'account',
            'month',
            'maand',
            'week',
            'day',
            'dag',
            'year',
            'jaar',
            'schedule',
            'planning',
            'tasks',
            'taken',
            'keep',
            'contacts',
            'contacten',
            'my calendars',
            "mijn agenda's",
            'other calendars',
            "andere agenda's"
        ]);

        return rejected.has(
            text.toLowerCase()
        );
    }

    function getCalendarName(element) {
        const directCandidates = [
            element.getAttribute('aria-label'),
            element.getAttribute('data-tooltip'),
            element.getAttribute('title')
        ];

        for (const candidate of directCandidates) {
            const name =
                cleanCalendarName(candidate);

            if (
                name &&
                name.length <= 120 &&
                !looksLikeDateControl(name) &&
                !looksLikeUiControl(name)
            ) {
                return name;
            }
        }

        let node = element.parentElement;

        for (
            let depth = 0;
            depth < 3 && node;
            depth++, node = node.parentElement
        ) {
            const lines =
                (node.innerText || '')
                    .split('\n')
                    .map(
                        line =>
                            cleanCalendarName(line)
                    )
                    .filter(Boolean);

            if (lines.length > 4) {
                break;
            }

            const candidates = lines
                .filter(
                    line => line.length <= 120
                )
                .filter(
                    line =>
                        !looksLikeDateControl(line)
                )
                .filter(
                    line =>
                        !looksLikeUiControl(line)
                )
                .sort(
                    (a, b) =>
                        b.length - a.length
                );

            if (candidates.length > 0) {
                return candidates[0];
            }
        }

        return null;
    }

    function findToggleCandidates() {
        const selector = [
            '[role="checkbox"][aria-checked]',
            '[role="switch"][aria-checked]',
            'input[type="checkbox"]',
            '[aria-checked="true"]',
            '[aria-checked="false"]'
        ].join(',');

        return [
            ...document.querySelectorAll(
                selector
            )
        ]
            .filter(isVisible)
            .filter(element => {
                const rect =
                    element.getBoundingClientRect();

                if (
                    rect.left > 450 ||
                    rect.top < 260
                ) {
                    return false;
                }

                if (
                    getCheckedState(element) ===
                    null
                ) {
                    return false;
                }

                const name =
                    getCalendarName(element);

                return (
                    Boolean(name) &&
                    !looksLikeDateControl(name) &&
                    !looksLikeUiControl(name)
                );
            });
    }

    function getCalendarToggles() {
        const candidates =
            findToggleCandidates();

        const occurrenceCounter =
            new Map();

        return candidates.map(element => {
            const name =
                getCalendarName(element);

            const occurrence =
                (occurrenceCounter.get(name) ||
                    0) + 1;

            occurrenceCounter.set(
                name,
                occurrence
            );

            return {
                id: JSON.stringify([
                    name,
                    occurrence
                ]),
                name,
                occurrence,
                element,
                checked:
                    getCheckedState(element)
            };
        });
    }

    function getDisplayName(
        calendar,
        calendars
    ) {
        const sameNameCount =
            calendars.filter(
                item =>
                    item.name === calendar.name
            ).length;

        return sameNameCount > 1
            ? `${calendar.name} [${calendar.occurrence}]`
            : calendar.name;
    }

    async function waitForCalendars(
        timeout = 10000
    ) {
        const started = Date.now();

        while (
            Date.now() - started < timeout
        ) {
            const calendars =
                getCalendarToggles();

            if (calendars.length > 0) {
                return calendars;
            }

            await sleep(250);
        }

        return [];
    }

    async function clickToggle(
        calendar,
        targetState
    ) {
        const currentState =
            getCheckedState(calendar.element);

        if (currentState === targetState) {
            return;
        }

        calendar.element.dispatchEvent(
            new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                view: window
            })
        );

        await sleep(180);
    }

    function loadPrimaryCalendars() {
        const saved =
            localStorage.getItem(
                STORAGE_KEY_PRIMARY
            );

        if (!saved) {
            return null;
        }

        try {
            const value =
                JSON.parse(saved);

            return Array.isArray(value)
                ? value
                : null;
        } catch {
            return null;
        }
    }

    async function choosePrimaryCalendars(
        calendars
    ) {
        const numbered =
            calendars
                .map(
                    (calendar, index) =>
                        `${index + 1}. ${getDisplayName(
                            calendar,
                            calendars
                        )}`
                )
                .join('\n');

        const answer = prompt(
            'Which calendars are yours?\n\n' +
            numbered +
            '\n\nEnter one or more numbers separated by commas.\n' +
            'Example: 1,2,5'
        );

        if (answer === null) {
            return null;
        }

        const indexes = [
            ...new Set(
                answer
                    .split(',')
                    .map(
                        value =>
                            Number.parseInt(
                                value.trim(),
                                10
                            ) - 1
                    )
            )
        ];

        if (
            indexes.length === 0 ||
            indexes.some(
                index =>
                    Number.isNaN(index) ||
                    index < 0 ||
                    index >=
                        calendars.length
            )
        ) {
            alert(
                'Invalid selection.\n\n' +
                'Enter calendar numbers separated by commas, ' +
                'for example: 1,2,5'
            );

            return null;
        }

        const selectedIds =
            indexes.map(
                index =>
                    calendars[index].id
            );

        localStorage.setItem(
            STORAGE_KEY_PRIMARY,
            JSON.stringify(selectedIds)
        );

        return selectedIds;
    }

    async function ensurePrimaryCalendars(
        calendars
    ) {
        let primaryIds =
            loadPrimaryCalendars();

        if (
            !primaryIds ||
            primaryIds.length === 0 ||
            primaryIds.some(
                id =>
                    !calendars.some(
                        calendar =>
                            calendar.id === id
                    )
            )
        ) {
            primaryIds =
                await choosePrimaryCalendars(
                    calendars
                );
        }

        return primaryIds;
    }

    async function activateMineOnly() {
        const calendars =
            await waitForCalendars();

        if (!calendars.length) {
            showDetectionError();
            return;
        }

        const primaryIds =
            await ensurePrimaryCalendars(
                calendars
            );

        if (!primaryIds) {
            return;
        }

        const previousState =
            calendars.map(calendar => ({
                id: calendar.id,
                checked:
                    getCheckedState(
                        calendar.element
                    )
            }));

        localStorage.setItem(
            STORAGE_KEY_STATE,
            JSON.stringify(previousState)
        );

        for (
            const savedCalendar
            of previousState
        ) {
            const currentCalendar =
                getCalendarToggles().find(
                    calendar =>
                        calendar.id ===
                        savedCalendar.id
                );

            if (!currentCalendar) {
                continue;
            }

            await clickToggle(
                currentCalendar,
                primaryIds.includes(
                    savedCalendar.id
                )
            );
        }

        mineOnlyActive = true;
        updateButtons();
    }

    async function restorePreviousState() {
        const saved =
            localStorage.getItem(
                STORAGE_KEY_STATE
            );

        if (!saved) {
            alert(
                'No previous calendar state has been saved yet.'
            );
            return;
        }

        let previousState;

        try {
            previousState =
                JSON.parse(saved);
        } catch {
            alert(
                'The saved calendar state is invalid.'
            );
            return;
        }

        const calendars =
            await waitForCalendars();

        if (!calendars.length) {
            showDetectionError();
            return;
        }

        for (
            const savedCalendar
            of previousState
        ) {
            const currentCalendar =
                getCalendarToggles().find(
                    calendar =>
                        calendar.id ===
                        savedCalendar.id
                );

            if (!currentCalendar) {
                continue;
            }

            await clickToggle(
                currentCalendar,
                Boolean(
                    savedCalendar.checked
                )
            );
        }

        mineOnlyActive = false;
        updateButtons();
    }

    function resetPrimaryCalendars() {
        localStorage.removeItem(
            STORAGE_KEY_PRIMARY
        );

        mineOnlyActive = false;
        dimOthersActive = false;

        clearDimmedEvents();

        alert(
            'Your calendar selection has been reset.\n\n' +
            'Click "Mine only" or "Dim others" to choose your calendars again.'
        );

        updateButtons();
    }

    /* -------------------------------------------------------
     * DIM OTHER CALENDARS
     * ----------------------------------------------------- */

    function ensureDimStyle() {
        if (
            document.getElementById(
                DIM_STYLE_ID
            )
        ) {
            return;
        }

        const style =
            document.createElement('style');

        style.id = DIM_STYLE_ID;

        style.textContent =
            `.${DIM_CLASS} { ` +
            `opacity: ${DIM_OPACITY} !important; ` +
            `}`;

        document.head.appendChild(style);
    }

    function normalizeColor(color) {
        if (!color) {
            return null;
        }

        const value =
            color.trim().toLowerCase();

        if (
            value === 'transparent' ||
            value ===
                'rgba(0, 0, 0, 0)' ||
            value ===
                'rgb(255, 255, 255)' ||
            value ===
                'rgb(0, 0, 0)'
        ) {
            return null;
        }

        return value;
    }

    function getCalendarColorCandidates(
        calendar
    ) {
        const colors = new Set();

        let node = calendar.element;

        for (
            let depth = 0;
            depth < 4 && node;
            depth++, node = node.parentElement
        ) {
            const descendants = [
                node,
                ...node.querySelectorAll('*')
            ];

            for (
                const element
                of descendants.slice(0, 40)
            ) {
                const style =
                    getComputedStyle(element);

                const candidates = [
                    style.backgroundColor,
                    style.borderColor,
                    style.color
                ];

                for (
                    const color
                    of candidates
                ) {
                    const normalized =
                        normalizeColor(color);

                    if (normalized) {
                        colors.add(
                            normalized
                        );
                    }
                }
            }
        }

        return colors;
    }

    function getEventColorCandidates(
        element
    ) {
        const colors = new Set();

        let node = element;

        for (
            let depth = 0;
            depth < 3 && node;
            depth++, node = node.parentElement
        ) {
            const style =
                getComputedStyle(node);

            const candidates = [
                style.backgroundColor,
                style.borderColor,
                style.borderLeftColor,
                style.borderTopColor,
                style.color
            ];

            for (
                const color
                of candidates
            ) {
                const normalized =
                    normalizeColor(color);

                if (normalized) {
                    colors.add(normalized);
                }
            }
        }

        return colors;
    }

    function getEventCandidates() {
        const selector = [
            '[data-eventid]',
            '[data-event-id]',
            '[data-eventchip]',
            '[role="button"][aria-label]'
        ].join(',');

        const seen = new Set();
        const result = [];

        for (
            const element
            of document.querySelectorAll(
                selector
            )
        ) {
            if (!isVisible(element)) {
                continue;
            }

            const rect =
                element.getBoundingClientRect();

            /*
             * Ignore Google's sidebar and top toolbar.
             */
            if (
                rect.left < 220 ||
                rect.top < 70
            ) {
                continue;
            }

            if (
                rect.width < 12 ||
                rect.height < 8
            ) {
                continue;
            }

            const text = [
                element.getAttribute(
                    'aria-label'
                ),
                element.getAttribute(
                    'title'
                ),
                element.getAttribute(
                    'data-tooltip'
                ),
                element.innerText
            ]
                .filter(Boolean)
                .join(' ');

            if (!text.trim()) {
                continue;
            }

            if (seen.has(element)) {
                continue;
            }

            seen.add(element);
            result.push(element);
        }

        return result;
    }

    function eventLooksMine(
        eventElement,
        mineNames,
        mineColors
    ) {
        const searchableText = [
            eventElement.getAttribute(
                'aria-label'
            ),
            eventElement.getAttribute(
                'title'
            ),
            eventElement.getAttribute(
                'data-tooltip'
            ),
            eventElement.innerText
        ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

        /*
         * First try calendar-name information exposed
         * by Google in accessibility metadata.
         */
        for (const name of mineNames) {
            if (
                name &&
                searchableText.includes(
                    name.toLowerCase()
                )
            ) {
                return true;
            }
        }

        /*
         * Fallback: compare the visible event color
         * against colors from your selected calendars.
         */
        const eventColors =
            getEventColorCandidates(
                eventElement
            );

        for (const color of eventColors) {
            if (mineColors.has(color)) {
                return true;
            }
        }

        return false;
    }

    function clearDimmedEvents() {
        document
            .querySelectorAll(
                `.${DIM_CLASS}`
            )
            .forEach(element => {
                element.classList.remove(
                    DIM_CLASS
                );
            });
    }

    async function applyDimOthers() {
        const calendars =
            await waitForCalendars();

        if (!calendars.length) {
            showDetectionError();
            return false;
        }

        const primaryIds =
            await ensurePrimaryCalendars(
                calendars
            );

        if (!primaryIds) {
            return false;
        }

        ensureDimStyle();
        clearDimmedEvents();

        const mineCalendars =
            calendars.filter(
                calendar =>
                    primaryIds.includes(
                        calendar.id
                    )
            );

        const mineNames = [
            ...new Set(
                mineCalendars.map(
                    calendar =>
                        calendar.name
                )
            )
        ];

        const mineColors = new Set();

        for (
            const calendar
            of mineCalendars
        ) {
            for (
                const color
                of getCalendarColorCandidates(
                    calendar
                )
            ) {
                mineColors.add(color);
            }
        }

        for (
            const eventElement
            of getEventCandidates()
        ) {
            if (
                !eventLooksMine(
                    eventElement,
                    mineNames,
                    mineColors
                )
            ) {
                eventElement.classList.add(
                    DIM_CLASS
                );
            }
        }

        return true;
    }

    function scheduleDimRefresh() {
        if (!dimOthersActive) {
            return;
        }

        clearTimeout(
            dimRefreshTimer
        );

        dimRefreshTimer =
            setTimeout(() => {
                applyDimOthers()
                    .catch(error => {
                        console.error(
                            '[GCal Mine Only] Failed to refresh dimming:',
                            error
                        );
                    });
            }, 250);
    }

    async function toggleDimOthers() {
        if (busy) {
            return;
        }

        busy = true;
        updateButtons();

        try {
            if (dimOthersActive) {
                clearDimmedEvents();

                dimOthersActive = false;
            } else {
                const applied =
                    await applyDimOthers();

                if (applied) {
                    dimOthersActive = true;
                }
            }
        } catch (error) {
            console.error(
                '[GCal Mine Only]',
                error
            );

            alert(
                'Could not apply transparency.\n\n' +
                'Check the browser console for details.'
            );
        } finally {
            busy = false;
            updateButtons();
        }
    }

    /* -------------------------------------------------------
     * BUTTONS
     * ----------------------------------------------------- */

    function showDetectionError() {
        alert(
            'I could not find the calendar toggles.\n\n' +
            'Make sure the left Google Calendar sidebar is visible.\n\n' +
            'If it still fails, open DevTools -> Console and run:\n\n' +
            'GCAL_MINE_ONLY_DEBUG()'
        );
    }

    async function toggleMineOnly() {
        if (busy) {
            return;
        }

        busy = true;
        updateButtons();

        try {
            if (mineOnlyActive) {
                await restorePreviousState();
            } else {
                await activateMineOnly();
            }

            /*
             * If dimming is currently enabled, recalculate
             * after calendars were shown/hidden.
             */
            if (dimOthersActive) {
                await applyDimOthers();
            }
        } catch (error) {
            console.error(
                '[GCal Mine Only]',
                error
            );

            alert(
                'Google Calendar Mine Only encountered an error.\n\n' +
                'Check the browser console for details.'
            );
        } finally {
            busy = false;
            updateButtons();
        }
    }

    function updateButtons() {
        const mainButton =
            document.getElementById(
                BUTTON_ID
            );

        const dimButton =
            document.getElementById(
                DIM_BUTTON_ID
            );

        if (mainButton) {
            mainButton.disabled = busy;

            mainButton.textContent =
                busy
                    ? 'Working...'
                    : (
                        mineOnlyActive
                            ? 'Restore calendars'
                            : 'Mine only'
                    );

            mainButton.title =
                mineOnlyActive
                    ? 'Restore the calendars that were visible before'
                    : 'Show only your selected calendars';
        }

        if (dimButton) {
            dimButton.disabled = busy;

            dimButton.textContent =
                busy
                    ? 'Working...'
                    : (
                        dimOthersActive
                            ? 'Undim others'
                            : 'Dim others'
                    );

            dimButton.title =
                dimOthersActive
                    ? 'Restore other calendar events to full opacity'
                    : 'Show other calendar events at 50% opacity';
        }
    }

    function styleButton(
        button,
        bottom
    ) {
        Object.assign(
            button.style,
            {
                position: 'fixed',
                left: '16px',
                bottom,
                zIndex: '99999',
                padding: '8px 13px',
                border:
                    '1px solid #dadce0',
                borderRadius: '18px',
                background: '#fff',
                color: '#3c4043',
                fontFamily:
                    'Google Sans, Roboto, Arial, sans-serif',
                fontSize: '13px',
                fontWeight: '500',
                cursor: 'pointer',
                boxShadow:
                    '0 1px 3px rgba(60,64,67,.3)'
            }
        );

        button.addEventListener(
            'mouseenter',
            () => {
                if (!button.disabled) {
                    button.style.background =
                        '#f8f9fa';
                }
            }
        );

        button.addEventListener(
            'mouseleave',
            () => {
                button.style.background =
                    '#fff';
            }
        );
    }

    function createButtons() {
        if (
            !document.getElementById(
                BUTTON_ID
            )
        ) {
            const button =
                document.createElement(
                    'button'
                );

            button.id = BUTTON_ID;
            button.type = 'button';

            styleButton(
                button,
                '18px'
            );

            button.addEventListener(
                'click',
                event => {
                    /*
                     * Shift-click resets which calendars
                     * are considered yours.
                     */
                    if (event.shiftKey) {
                        event.preventDefault();
                        event.stopPropagation();

                        resetPrimaryCalendars();
                        return;
                    }

                    toggleMineOnly();
                }
            );

            document.body.appendChild(
                button
            );
        }

        if (
            !document.getElementById(
                DIM_BUTTON_ID
            )
        ) {
            const dimButton =
                document.createElement(
                    'button'
                );

            dimButton.id =
                DIM_BUTTON_ID;

            dimButton.type = 'button';

            styleButton(
                dimButton,
                '58px'
            );

            dimButton.addEventListener(
                'click',
                toggleDimOthers
            );

            document.body.appendChild(
                dimButton
            );
        }

        updateButtons();
    }

    /* -------------------------------------------------------
     * DEBUG
     * ----------------------------------------------------- */

    window.GCAL_MINE_ONLY_DEBUG =
        function () {
            const calendars =
                getCalendarToggles();

            const primaryIds =
                loadPrimaryCalendars() ||
                [];

            const results =
                calendars.map(
                    (calendar, index) => ({
                        number:
                            index + 1,
                        id:
                            calendar.id,
                        name:
                            calendar.name,
                        occurrence:
                            calendar.occurrence,
                        displayName:
                            getDisplayName(
                                calendar,
                                calendars
                            ),
                        checked:
                            calendar.checked,
                        selectedAsMine:
                            primaryIds.includes(
                                calendar.id
                            ),
                        ariaLabel:
                            calendar.element
                                .getAttribute(
                                    'aria-label'
                                ),
                        role:
                            calendar.element
                                .getAttribute(
                                    'role'
                                )
                    })
                );

            console.table(results);

            console.log(
                '[GCal Mine Only] Event candidates:',
                getEventCandidates().length
            );

            console.log(
                '[GCal Mine Only] Dim active:',
                dimOthersActive
            );

            return results;
        };

    /* -------------------------------------------------------
     * INITIALISE
     * ----------------------------------------------------- */

    ensureDimStyle();
    createButtons();

    const observer =
        new MutationObserver(() => {
            if (
                !document.getElementById(
                    BUTTON_ID
                ) ||
                !document.getElementById(
                    DIM_BUTTON_ID
                )
            ) {
                createButtons();
            }

            /*
             * Google Calendar adds/removes event DOM nodes
             * while navigating weeks, scrolling, etc.
             */
            scheduleDimRefresh();
        });

    observer.observe(
        document.documentElement,
        {
            childList: true,
            subtree: true
        }
    );
})();
