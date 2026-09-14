// ==UserScript==
// @name         Google Calendar - Mine Only / Restore
// @namespace    local.gcal.mine-only
// @version      1.2.0
// @description  Toggle between your own calendars and your previous Google Calendar visibility state.
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

    let mineOnlyActive = false;
    let busy = false;

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

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

        const ariaChecked = element.getAttribute('aria-checked');

        if (ariaChecked === 'true') return true;
        if (ariaChecked === 'false') return false;

        return null;
    }

    function looksLikeDateControl(text) {
        if (!text) return false;

        const datePatterns = [
            /^\d{1,2}\s*,\s*\p{L}+/iu,
            /^\d{1,2}\s+\p{L}+\s*,\s*\p{L}+/iu,
            /^\d{1,2}\s+\p{L}+\s+\d{4}$/iu,
            /^\p{L}+\s+\d{1,2}(?:,\s*\d{4})?$/iu
        ];

        return datePatterns.some(pattern => pattern.test(text));
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
            'mijn agenda\'s',
            'other calendars',
            'andere agenda\'s'
        ]);

        return rejected.has(text.toLowerCase());
    }

    function getCalendarSidebarArea() {
        const possibleHeaders = new Set([
            'My calendars',
            'Other calendars',
            'Mijn agenda\'s',
            'Andere agenda\'s'
        ]);

        const allElements = [...document.querySelectorAll('body *')];

        const headers = allElements.filter(element => {
            const text = element.textContent?.trim();
            return possibleHeaders.has(text);
        });

        if (headers.length === 0) {
            return document.body;
        }

        const containers = headers
            .map(header => {
                let node = header;

                for (
                    let depth = 0;
                    depth < 7 && node;
                    depth++, node = node.parentElement
                ) {
                    const rect = node.getBoundingClientRect();

                    if (
                        rect.width > 150 &&
                        rect.width < 500 &&
                        rect.height > 40
                    ) {
                        return node;
                    }
                }

                return header.parentElement;
            })
            .filter(Boolean);

        if (containers.length === 0) {
            return document.body;
        }

        let common = containers[0];

        while (
            common &&
            !containers.every(container => common.contains(container))
        ) {
            common = common.parentElement;
        }

        return common || document.body;
    }

    function getCalendarName(element) {
        const directCandidates = [
            element.getAttribute('aria-label'),
            element.getAttribute('data-tooltip'),
            element.getAttribute('title')
        ];

        for (const candidate of directCandidates) {
            const name = cleanCalendarName(candidate);

            if (
                name &&
                name.length <= 120 &&
                !looksLikeDateControl(name)
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
            const rawText = node.innerText || '';

            const lines = rawText
                .split('\n')
                .map(line => cleanCalendarName(line))
                .filter(Boolean);

            if (lines.length > 4) {
                break;
            }

            const candidates = lines
                .filter(line => line.length <= 120)
                .filter(line => !looksLikeDateControl(line))
                .filter(line => !looksLikeUiControl(line))
                .sort((a, b) => b.length - a.length);

            if (candidates.length > 0) {
                return candidates[0];
            }
        }

        return null;
    }

    function findToggleCandidates() {
        const sidebar = getCalendarSidebarArea();

        const selector = [
            '[role="checkbox"][aria-checked]',
            '[role="switch"][aria-checked]',
            'input[type="checkbox"]',
            '[aria-checked="true"]',
            '[aria-checked="false"]'
        ].join(',');

        return [...sidebar.querySelectorAll(selector)]
            .filter(isVisible)
            .filter(element => {
                const rect = element.getBoundingClientRect();

                if (rect.left > 450) {
                    return false;
                }

                if (rect.top < 260) {
                    return false;
                }

                if (getCheckedState(element) === null) {
                    return false;
                }

                const name = getCalendarName(element);

                if (!name) {
                    return false;
                }

                if (looksLikeDateControl(name)) {
                    return false;
                }

                if (looksLikeUiControl(name)) {
                    return false;
                }

                return true;
            });
    }

    /**
     * Return all detected calendars.
     *
     * Duplicate names are intentionally preserved.
     *
     * Each calendar gets an ID consisting of:
     *
     *     calendar name + occurrence number
     *
     * Example:
     *
     *     Work #1
     *     Work #2
     *     Work #3
     *
     * The occurrence number is based on sidebar order.
     */
    function getCalendarToggles() {
        const candidates = findToggleCandidates();

        const occurrenceCounter = new Map();
        const calendars = [];

        for (const element of candidates) {
            const name = getCalendarName(element);

            if (!name) {
                continue;
            }

            const occurrence =
                (occurrenceCounter.get(name) || 0) + 1;

            occurrenceCounter.set(name, occurrence);

            const id = JSON.stringify([
                name,
                occurrence
            ]);

            calendars.push({
                id,
                name,
                occurrence,
                element,
                checked: getCheckedState(element)
            });
        }

        return calendars;
    }

    function getDisplayName(calendar, calendars) {
        const sameNameCount = calendars.filter(
            item => item.name === calendar.name
        ).length;

        if (sameNameCount > 1) {
            return `${calendar.name} [${calendar.occurrence}]`;
        }

        return calendar.name;
    }

    async function waitForCalendars(timeout = 10000) {
        const started = Date.now();

        while (Date.now() - started < timeout) {
            const calendars = getCalendarToggles();

            if (calendars.length > 0) {
                console.table(
                    calendars.map(calendar => ({
                        id: calendar.id,
                        name: calendar.name,
                        occurrence: calendar.occurrence,
                        checked: calendar.checked,
                        tag: calendar.element.tagName,
                        role: calendar.element.getAttribute('role'),
                        ariaLabel:
                            calendar.element.getAttribute('aria-label')
                    }))
                );

                return calendars;
            }

            await sleep(250);
        }

        return [];
    }

    async function clickToggle(calendar, targetState) {
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

    /**
     * Let the user choose one or more calendars.
     *
     * Accepted input examples:
     *
     *     1
     *     1,2,3
     *     1, 3, 7
     */
    async function choosePrimaryCalendars(calendars) {
        const numbered = calendars
            .map(
                (calendar, index) =>
                    `${index + 1}. ${getDisplayName(calendar, calendars)}`
            )
            .join('\n');

        const answer = prompt(
            'Which calendars are yours?\n\n' +
            numbered +
            '\n\n' +
            'Enter one or more numbers separated by commas.\n' +
            'Example: 1,2,5'
        );

        if (answer === null) {
            return null;
        }

        const indexes = [
            ...new Set(
                answer
                    .split(',')
                    .map(value => Number.parseInt(value.trim(), 10) - 1)
            )
        ];

        if (
            indexes.length === 0 ||
            indexes.some(
                index =>
                    Number.isNaN(index) ||
                    index < 0 ||
                    index >= calendars.length
            )
        ) {
            alert(
                'Invalid selection.\n\n' +
                'Enter calendar numbers separated by commas, for example:\n\n' +
                '1,2,5'
            );

            return null;
        }

        const selectedIds =
            indexes.map(index => calendars[index].id);

        localStorage.setItem(
            STORAGE_KEY_PRIMARY,
            JSON.stringify(selectedIds)
        );

        return selectedIds;
    }

    function loadPrimaryCalendars() {
        const saved =
            localStorage.getItem(STORAGE_KEY_PRIMARY);

        if (!saved) {
            return null;
        }

        try {
            const value = JSON.parse(saved);

            if (!Array.isArray(value)) {
                return null;
            }

            return value;
        } catch {
            return null;
        }
    }

    async function activateMineOnly() {
        const calendars = await waitForCalendars();

        if (!calendars.length) {
            showDetectionError();
            return;
        }

        let primaryIds = loadPrimaryCalendars();

        /*
         * Re-run setup if there is no saved selection or if one of the
         * previously selected calendars can no longer be found.
         */
        if (
            !primaryIds ||
            primaryIds.length === 0 ||
            primaryIds.some(
                id => !calendars.some(calendar => calendar.id === id)
            )
        ) {
            primaryIds =
                await choosePrimaryCalendars(calendars);

            if (!primaryIds) {
                return;
            }
        }

        /*
         * Save the complete current visibility state.
         */
        const previousState =
            calendars.map(calendar => ({
                id: calendar.id,
                name: calendar.name,
                occurrence: calendar.occurrence,
                checked:
                    getCheckedState(calendar.element)
            }));

        localStorage.setItem(
            STORAGE_KEY_STATE,
            JSON.stringify(previousState)
        );

        /*
         * Toggle calendars one at a time.
         *
         * The DOM is re-read after every click because Google Calendar can
         * rebuild sidebar nodes whenever visibility changes.
         */
        for (const savedCalendar of previousState) {
            const currentCalendars =
                getCalendarToggles();

            const currentCalendar =
                currentCalendars.find(
                    calendar =>
                        calendar.id === savedCalendar.id
                );

            if (!currentCalendar) {
                continue;
            }

            const shouldBeVisible =
                primaryIds.includes(savedCalendar.id);

            await clickToggle(
                currentCalendar,
                shouldBeVisible
            );
        }

        mineOnlyActive = true;
        updateButton();
    }

    async function restorePreviousState() {
        const saved =
            localStorage.getItem(STORAGE_KEY_STATE);

        if (!saved) {
            alert(
                'No previous calendar state has been saved yet.'
            );
            return;
        }

        let previousState;

        try {
            previousState = JSON.parse(saved);
        } catch {
            alert(
                'The saved calendar state is invalid.'
            );
            return;
        }

        const calendars = await waitForCalendars();

        if (!calendars.length) {
            showDetectionError();
            return;
        }

        for (const savedCalendar of previousState) {
            const currentCalendars =
                getCalendarToggles();

            const currentCalendar =
                currentCalendars.find(
                    calendar =>
                        calendar.id === savedCalendar.id
                );

            if (!currentCalendar) {
                continue;
            }

            await clickToggle(
                currentCalendar,
                Boolean(savedCalendar.checked)
            );
        }

        mineOnlyActive = false;
        updateButton();
    }

    function resetPrimaryCalendars() {
        localStorage.removeItem(
            STORAGE_KEY_PRIMARY
        );

        mineOnlyActive = false;

        alert(
            'Your calendar selection has been reset.\n\n' +
            'Click "Mine only" again to choose your calendars.'
        );

        updateButton();
    }

    function showDetectionError() {
        alert(
            'I could not find the calendar toggles.\n\n' +
            'Make sure the left Google Calendar sidebar is visible.\n\n' +
            'If it still fails, open DevTools → Console and run:\n\n' +
            'GCAL_MINE_ONLY_DEBUG()'
        );
    }

    async function toggle() {
        if (busy) {
            return;
        }

        busy = true;
        updateButton();

        try {
            if (mineOnlyActive) {
                await restorePreviousState();
            } else {
                await activateMineOnly();
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
            updateButton();
        }
    }

    function updateButton() {
        const button =
            document.getElementById(BUTTON_ID);

        if (!button) {
            return;
        }

        if (busy) {
            button.disabled = true;
            button.textContent = 'Working…';
            return;
        }

        button.disabled = false;

        button.textContent = mineOnlyActive
            ? 'Restore calendars'
            : 'Mine only';

        button.title = mineOnlyActive
            ? 'Restore the calendars that were visible before'
            : 'Show only your selected calendars';
    }

    function createButton() {
        if (
            document.getElementById(BUTTON_ID)
        ) {
            return;
        }

        const button =
            document.createElement('button');

        button.id = BUTTON_ID;
        button.type = 'button';

        Object.assign(button.style, {
            position: 'fixed',
            left: '16px',
            bottom: '18px',
            zIndex: '99999',
            padding: '8px 13px',
            border: '1px solid #dadce0',
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
        });

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
                button.style.background = '#fff';
            }
        );

        button.addEventListener(
            'click',
            event => {
                /*
                 * Shift-click resets which calendars count as "mine".
                 */
                if (event.shiftKey) {
                    event.preventDefault();
                    event.stopPropagation();

                    resetPrimaryCalendars();
                    return;
                }

                toggle();
            }
        );

        document.body.appendChild(button);

        updateButton();
    }

    /**
     * Debug helper:
     *
     *     GCAL_MINE_ONLY_DEBUG()
     */
    window.GCAL_MINE_ONLY_DEBUG = function () {
        const calendars = getCalendarToggles();

        const results = calendars.map(
            (calendar, index) => ({
                number: index + 1,
                id: calendar.id,
                name: calendar.name,
                occurrence: calendar.occurrence,
                displayName:
                    getDisplayName(calendar, calendars),
                checked: calendar.checked,
                ariaLabel:
                    calendar.element.getAttribute(
                        'aria-label'
                    ),
                role:
                    calendar.element.getAttribute(
                        'role'
                    )
            })
        );

        console.table(results);

        console.log(
            '[GCal Mine Only] Selected calendars:',
            loadPrimaryCalendars()
        );

        return results;
    };

    function initialise() {
        createButton();
    }

    initialise();

    const observer = new MutationObserver(
        () => {
            if (
                !document.getElementById(
                    BUTTON_ID
                )
            ) {
                initialise();
            }
        }
    );

    observer.observe(
        document.documentElement,
        {
            child
