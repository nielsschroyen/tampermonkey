// ==UserScript==
// @name         Google Calendar - Mine Only / Restore
// @namespace    local.gcal.mine-only
// @version      1.1.1
// @description  Toggle between your own calendar and your previous Google Calendar visibility state.
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

    const STORAGE_KEY_PRIMARY = 'gcalMineOnly.primaryCalendar';
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

    /**
     * Find the area of the left drawer that contains the calendar lists.
     *
     * We try common section headings first. If those are localized or Google
     * changes the markup, we fall back to scanning the page and filtering
     * controls by position and behavior.
     */
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

    /**
     * Extract the calendar name.
     *
     * Do not climb far through the DOM. Doing that caused mini-calendar dates
     * such as "31 augustus, Maandag" to be interpreted as calendar names.
     */
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

            /*
             * Calendar rows are compact. If we reached a larger block with
             * many lines, stop before accidentally using unrelated sidebar
             * content.
             */
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

    function looksLikeDateControl(text) {
        if (!text) return false;

        /*
         * Handles examples such as:
         *   31 augustus, Maandag
         *   1, Dinsdag
         *   14 September, Monday
         */
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

    /**
     * Find likely calendar visibility controls.
     *
     * Important:
     * - Do not use [aria-pressed]; Google uses that for many unrelated controls.
     * - Restrict candidates to the left drawer.
     * - Exclude the mini month picker near the top.
     */
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

                /*
                 * Exclude controls in the top navigation and mini month picker.
                 *
                 * This is intentionally generous because users can resize the
                 * viewport and Google's sidebar dimensions can vary.
                 */
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

    function getCalendarToggles() {
        const candidates = findToggleCandidates();
        const result = [];
        const seen = new Set();

        for (const element of candidates) {
            const name = getCalendarName(element);

            if (!name) {
                continue;
            }

            if (seen.has(name)) {
                continue;
            }

            seen.add(name);

            result.push({
                element,
                name,
                checked: getCheckedState(element)
            });
        }

        return result;
    }

    async function waitForCalendars(timeout = 10000) {
        const started = Date.now();

        while (Date.now() - started < timeout) {
            const calendars = getCalendarToggles();

            if (calendars.length > 0) {
                console.table(
                    calendars.map(calendar => ({
                        name: calendar.name,
                        checked: calendar.checked,
                        tag: calendar.element.tagName,
                        role: calendar.element.getAttribute('role'),
                        ariaLabel: calendar.element.getAttribute('aria-label')
                    }))
                );

                return calendars;
            }

            await sleep(250);
        }

        return [];
    }

    async function clickToggle(calendar, targetState) {
        const currentState = getCheckedState(calendar.element);

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

        /*
         * Calendar can rebuild the sidebar after every visibility change.
         */
        await sleep(180);
    }

    async function choosePrimaryCalendar(calendars) {
        const numbered = calendars
            .map(
                (calendar, index) =>
                    `${index + 1}. ${calendar.name}`
            )
            .join('\n');

        const answer = prompt(
            'Which calendar is yours?\n\n' +
            numbered +
            '\n\nEnter the number of your calendar:'
        );

        if (answer === null) {
            return null;
        }

        const index = Number.parseInt(answer, 10) - 1;

        if (
            Number.isNaN(index) ||
            index < 0 ||
            index >= calendars.length
        ) {
            alert('Invalid calendar number.');
            return null;
        }

        const selected = calendars[index].name;

        localStorage.setItem(
            STORAGE_KEY_PRIMARY,
            selected
        );

        return selected;
    }

    async function activateMineOnly() {
        const calendars = await waitForCalendars();

        if (!calendars.length) {
            showDetectionError();
            return;
        }

        let primaryName =
            localStorage.getItem(STORAGE_KEY_PRIMARY);

        if (
            !primaryName ||
            !calendars.some(
                calendar => calendar.name === primaryName
            )
        ) {
            primaryName =
                await choosePrimaryCalendar(calendars);

            if (!primaryName) {
                return;
            }
        }

        /*
         * Save exactly what is currently visible.
         */
        const previousState =
            calendars.map(calendar => ({
                name: calendar.name,
                checked:
                    getCheckedState(calendar.element)
            }));

        localStorage.setItem(
            STORAGE_KEY_STATE,
            JSON.stringify(previousState)
        );

        /*
         * Re-read the sidebar before each click because Google Calendar may
         * replace DOM nodes when visibility changes.
         */
        for (const savedCalendar of previousState) {
            const currentCalendars =
                getCalendarToggles();

            const currentCalendar =
                currentCalendars.find(
                    calendar =>
                        calendar.name ===
                        savedCalendar.name
                );

            if (!currentCalendar) {
                continue;
            }

            await clickToggle(
                currentCalendar,
                savedCalendar.name === primaryName
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
                        calendar.name ===
                        savedCalendar.name
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
            : 'Show only your calendar';
    }

    function resetPrimaryCalendar() {
        localStorage.removeItem(
            STORAGE_KEY_PRIMARY
        );

        mineOnlyActive = false;

        alert(
            'Primary calendar reset.\n\n' +
            'Click "Mine only" again to choose your calendar.'
        );

        updateButton();
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
                 * Shift-click resets the selected primary calendar.
                 */
                if (event.shiftKey) {
                    event.preventDefault();
                    event.stopPropagation();

                    resetPrimaryCalendar();
                    return;
                }

                toggle();
            }
        );

        document.body.appendChild(button);

        updateButton();
    }

    /**
     * Debug helper.
     *
     * Run this from DevTools:
     *
     *     GCAL_MINE_ONLY_DEBUG()
     *
     * It prints potential sidebar controls and what the script thinks their
     * names are.
     */
    window.GCAL_MINE_ONLY_DEBUG = function () {
        const selector = [
            '[role="checkbox"][aria-checked]',
            '[role="switch"][aria-checked]',
            'input[type="checkbox"]',
            '[aria-checked="true"]',
            '[aria-checked="false"]'
        ].join(',');

        const results = [
            ...document.querySelectorAll(selector)
        ]
            .filter(isVisible)
            .filter(element => {
                const rect =
                    element.getBoundingClientRect();

                return rect.left < 500;
            })
            .map(element => {
                const rect =
                    element.getBoundingClientRect();

                return {
                    top: Math.round(rect.top),
                    left: Math.round(rect.left),
                    tag: element.tagName,
                    role:
                        element.getAttribute('role'),
                    ariaChecked:
                        element.getAttribute(
                            'aria-checked'
                        ),
                    ariaLabel:
                        element.getAttribute(
                            'aria-label'
                        ),
                    title:
                        element.getAttribute(
                            'title'
                        ),
                    detectedName:
                        getCalendarName(element),
                    rejectedAsDate:
                        looksLikeDateControl(
                            getCalendarName(element)
                        ),
                    text:
                        cleanCalendarName(
                            element.innerText ||
                            element.parentElement
                                ?.innerText ||
                            ''
                        ).slice(0, 150)
                };
            });

        console.table(results);

        console.log(
            '[GCal Mine Only] Final detected calendars:',
            getCalendarToggles().map(
                calendar => ({
                    name: calendar.name,
                    checked: calendar.checked
                })
            )
        );

        return results;
    };

    function initialise() {
        createButton();
    }

    initialise();

    /*
     * Google Calendar is a single-page application and occasionally rebuilds
     * large parts of its DOM. Recreate our button if that happens.
     */
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
            childList: true,
            subtree: true
        }
    );
})();
