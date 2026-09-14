// ==UserScript==
// @name         Google Calendar - Mine Only / Restore
// @namespace    local.gcal.mine-only
// @version      1.7.0
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

    const STORAGE_KEY_PRIMARY = 'gcalMineOnly.primaryCalendarIds';
    const STORAGE_KEY_STATE = 'gcalMineOnly.previousState';

    const TOOLBAR_ID = 'gcal-mine-only-toolbar';
    const BUTTON_ID = 'gcal-mine-only-toggle';
    const DIM_BUTTON_ID = 'gcal-dim-others-toggle';

    const DIM_CLASS = 'gcal-mine-only-dimmed';
    const DIM_STYLE_ID = 'gcal-mine-only-dim-style';

    /*
     * 0.25 = 25% opacity.
     */
    const DIM_OPACITY = 0.25;

    /*
     * Fixed toolbar position.
     *
     * Adjust these two values if you want to move it a few pixels.
     */
    const TOOLBAR_TOP = '78px';
    const TOOLBAR_LEFT = '265px';

    let mineOnlyActive = false;

    /*
     * true when the user clicked the Dim button.
     */
    let dimLocked = false;

    /*
     * true while the pointer is over the Dim button.
     */
    let dimHovered = false;

    let busy = false;
    let dimRefreshTimer = null;

    const sleep = ms =>
        new Promise(resolve => setTimeout(resolve, ms));

    /* -------------------------------------------------------
     * BASE64
     * ----------------------------------------------------- */

    function decodeBase64(value) {
        if (!value) {
            return null;
        }

        try {
            let normalized = value
                .replace(/-/g, '+')
                .replace(/_/g, '/');

            while (normalized.length % 4 !== 0) {
                normalized += '=';
            }

            const binary = atob(normalized);

            const bytes = Uint8Array.from(
                binary,
                char => char.charCodeAt(0)
            );

            return new TextDecoder().decode(bytes);
        } catch (error) {
            console.warn(
                '[GCal Mine Only] Could not decode Base64:',
                value,
                error
            );

            return null;
        }
    }

    /* -------------------------------------------------------
     * CALENDAR DETECTION
     * ----------------------------------------------------- */

    function isVisible(element) {
        const rect = element.getBoundingClientRect();

        return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.right > 0
        );
    }

    function getCalendarCheckboxes() {
        return [
            ...document.querySelectorAll(
                'input[type="checkbox"][jsname="YPqjbf"]'
            )
        ].filter(element => {
            if (!isVisible(element)) {
                return false;
            }

            return Boolean(
                element.closest('[data-id]')
            );
        });
    }

    function getCalendarInfo(checkbox) {
        const row =
            checkbox.closest('[data-id]');

        if (!row) {
            return null;
        }

        const encodedId =
            row.getAttribute('data-id');

        const calendarId =
            decodeBase64(encodedId);

        const name =
            checkbox.getAttribute('aria-label') ||
            row.innerText?.trim() ||
            calendarId ||
            'Unnamed calendar';

        if (!calendarId) {
            return null;
        }

        return {
            id: calendarId,
            encodedId,
            name,
            checkbox,
            row,
            checked: checkbox.checked
        };
    }

    function getCalendars() {
        return getCalendarCheckboxes()
            .map(getCalendarInfo)
            .filter(Boolean);
    }

    async function waitForCalendars(
        timeout = 10000
    ) {
        const started = Date.now();

        while (
            Date.now() - started < timeout
        ) {
            const calendars =
                getCalendars();

            if (calendars.length > 0) {
                return calendars;
            }

            await sleep(250);
        }

        return [];
    }

    async function setCalendarVisibility(
        calendar,
        targetState
    ) {
        if (
            calendar.checkbox.checked ===
            targetState
        ) {
            return;
        }

        calendar.checkbox.click();

        await sleep(180);
    }

    /* -------------------------------------------------------
     * PRIMARY CALENDARS
     * ----------------------------------------------------- */

    function loadPrimaryCalendarIds() {
        const raw =
            localStorage.getItem(
                STORAGE_KEY_PRIMARY
            );

        if (!raw) {
            return null;
        }

        try {
            const parsed =
                JSON.parse(raw);

            return Array.isArray(parsed)
                ? parsed
                : null;
        } catch {
            return null;
        }
    }

    function savePrimaryCalendarIds(ids) {
        localStorage.setItem(
            STORAGE_KEY_PRIMARY,
            JSON.stringify(ids)
        );
    }

    async function choosePrimaryCalendars(
        calendars
    ) {
        const duplicateCounts =
            new Map();

        for (const calendar of calendars) {
            duplicateCounts.set(
                calendar.name,
                (
                    duplicateCounts.get(
                        calendar.name
                    ) || 0
                ) + 1
            );
        }

        const occurrences =
            new Map();

        const numbered =
            calendars
                .map((calendar, index) => {
                    const occurrence =
                        (
                            occurrences.get(
                                calendar.name
                            ) || 0
                        ) + 1;

                    occurrences.set(
                        calendar.name,
                        occurrence
                    );

                    let displayName =
                        calendar.name;

                    if (
                        duplicateCounts.get(
                            calendar.name
                        ) > 1
                    ) {
                        displayName +=
                            ` [${occurrence}]`;
                    }

                    return (
                        `${index + 1}. ` +
                        displayName
                    );
                })
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
                    .map(
                        value =>
                            Number.parseInt(
                                value.trim(),
                                10
                            ) - 1
                    )
            )
        ];

        const invalid =
            indexes.length === 0 ||
            indexes.some(
                index =>
                    Number.isNaN(index) ||
                    index < 0 ||
                    index >= calendars.length
            );

        if (invalid) {
            alert(
                'Invalid selection.\n\n' +
                'Enter calendar numbers separated by commas.\n\n' +
                'Example: 1,2,5'
            );

            return null;
        }

        const ids =
            indexes.map(
                index =>
                    calendars[index].id
            );

        savePrimaryCalendarIds(ids);

        return ids;
    }

    async function ensurePrimaryCalendarIds(
        calendars
    ) {
        let ids =
            loadPrimaryCalendarIds();

        if (
            !ids ||
            ids.length === 0 ||
            ids.some(
                id =>
                    !calendars.some(
                        calendar =>
                            calendar.id === id
                    )
            )
        ) {
            ids =
                await choosePrimaryCalendars(
                    calendars
                );
        }

        return ids;
    }

    function resetPrimaryCalendars() {
        localStorage.removeItem(
            STORAGE_KEY_PRIMARY
        );

        localStorage.removeItem(
            STORAGE_KEY_STATE
        );

        clearDimmedEvents();

        mineOnlyActive = false;
        dimLocked = false;
        dimHovered = false;

        updateButtons();

        alert(
            'Your selected calendars have been reset.\n\n' +
            'Click "Mine only" or hover "Dim others" to configure them again.'
        );
    }

    /* -------------------------------------------------------
     * MINE ONLY
     * ----------------------------------------------------- */

    async function activateMineOnly() {
        const calendars =
            await waitForCalendars();

        if (!calendars.length) {
            showDetectionError();
            return;
        }

        const primaryIds =
            await ensurePrimaryCalendarIds(
                calendars
            );

        if (!primaryIds) {
            return;
        }

        const previousState =
            calendars.map(calendar => ({
                id: calendar.id,
                checked:
                    calendar.checkbox.checked
            }));

        localStorage.setItem(
            STORAGE_KEY_STATE,
            JSON.stringify(previousState)
        );

        for (
            const savedCalendar
            of previousState
        ) {
            const current =
                getCalendars().find(
                    calendar =>
                        calendar.id ===
                        savedCalendar.id
                );

            if (!current) {
                continue;
            }

            await setCalendarVisibility(
                current,
                primaryIds.includes(
                    savedCalendar.id
                )
            );
        }

        mineOnlyActive = true;

        updateButtons();
    }

    async function restoreCalendars() {
        const raw =
            localStorage.getItem(
                STORAGE_KEY_STATE
            );

        if (!raw) {
            alert(
                'No previous calendar state has been saved.'
            );

            return;
        }

        let previousState;

        try {
            previousState =
                JSON.parse(raw);
        } catch {
            alert(
                'The saved calendar state is invalid.'
            );

            return;
        }

        for (
            const savedCalendar
            of previousState
        ) {
            const current =
                getCalendars().find(
                    calendar =>
                        calendar.id ===
                        savedCalendar.id
                );

            if (!current) {
                continue;
            }

            await setCalendarVisibility(
                current,
                Boolean(
                    savedCalendar.checked
                )
            );
        }

        mineOnlyActive = false;

        updateButtons();
    }

    /* -------------------------------------------------------
     * EVENT DETECTION
     * ----------------------------------------------------- */

    function getEventElements() {
        return [
            ...document.querySelectorAll(
                '[data-eventid]'
            )
        ].filter(isVisible);
    }

    function getEventCalendarId(
        eventElement
    ) {
        const encoded =
            eventElement.getAttribute(
                'data-eventid'
            );

        const decoded =
            decodeBase64(encoded);

        if (!decoded) {
            return null;
        }

        /*
         * Example:
         *
         * <event-id>_<timestamp> calendar@example.com
         */
        const match =
            decoded.match(/\s(\S+)\s*$/);

        if (!match) {
            return null;
        }

        return match[1];
    }

    /* -------------------------------------------------------
     * DIM OTHERS
     * ----------------------------------------------------- */

    function isDimActive() {
        return (
            dimLocked ||
            dimHovered
        );
    }

    function ensureDimStyle() {
        if (
            document.getElementById(
                DIM_STYLE_ID
            )
        ) {
            return;
        }

        const style =
            document.createElement(
                'style'
            );

        style.id =
            DIM_STYLE_ID;

        style.textContent = `
            .${DIM_CLASS} {
                opacity: ${DIM_OPACITY} !important;
                transition: opacity 120ms ease;
            }
        `;

        document.head.appendChild(
            style
        );
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
            return false;
        }

        const primaryIds =
            await ensurePrimaryCalendarIds(
                calendars
            );

        if (!primaryIds) {
            return false;
        }

        ensureDimStyle();
        clearDimmedEvents();

        const events =
            getEventElements();

        let identified = 0;
        let mine = 0;
        let dimmed = 0;

        for (
            const eventElement
            of events
        ) {
            const calendarId =
                getEventCalendarId(
                    eventElement
                );

            /*
             * Unknown event ownership:
             * leave it untouched.
             */
            if (!calendarId) {
                continue;
            }

            identified++;

            if (
                primaryIds.includes(
                    calendarId
                )
            ) {
                mine++;
                continue;
            }

            eventElement.classList.add(
                DIM_CLASS
            );

            dimmed++;
        }

        console.log(
            '[GCal Mine Only] Dim results:',
            {
                eventsFound:
                    events.length,
                identified,
                mine,
                dimmed,
                opacity:
                    DIM_OPACITY
            }
        );

        return true;
    }

    async function refreshDimState() {
        if (isDimActive()) {
            await applyDimOthers();
        } else {
            clearDimmedEvents();
        }
    }

    async function toggleDimLock() {
        if (busy) {
            return;
        }

        dimLocked =
            !dimLocked;

        await refreshDimState();

        updateButtons();
    }

    async function startDimHover() {
        if (busy) {
            return;
        }

        dimHovered = true;

        try {
            await refreshDimState();
        } catch (error) {
            console.error(
                '[GCal Mine Only] Hover dim failed:',
                error
            );
        }

        updateButtons();
    }

    async function endDimHover() {
        dimHovered = false;

        /*
         * If the user clicked to lock dimming,
         * keep the events dimmed.
         */
        if (!dimLocked) {
            clearDimmedEvents();
        }

        updateButtons();
    }

    function scheduleDimRefresh() {
        if (!isDimActive()) {
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
                            '[GCal Mine Only] Could not refresh dimming:',
                            error
                        );
                    });
            }, 200);
    }

    /* -------------------------------------------------------
     * BUTTONS
     * ----------------------------------------------------- */

    function showDetectionError() {
        alert(
            'Could not find the Google Calendar sidebar calendars.'
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
                await restoreCalendars();
            } else {
                await activateMineOnly();
            }

            if (isDimActive()) {
                await applyDimOthers();
            }
        } catch (error) {
            console.error(
                '[GCal Mine Only]',
                error
            );
        } finally {
            busy = false;
            updateButtons();
        }
    }

    function styleButton(button) {
        Object.assign(
            button.style,
            {
                height: '32px',
                padding: '0 12px',
                border:
                    '1px solid #dadce0',
                borderRadius: '16px',
                background: '#fff',
                color: '#3c4043',
                fontFamily:
                    'Google Sans, Roboto, Arial, sans-serif',
                fontSize: '13px',
                fontWeight: '500',
                cursor: 'pointer',
                boxShadow:
                    '0 1px 2px rgba(60,64,67,.18)',
                whiteSpace: 'nowrap'
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

    function createToolbar() {
        let toolbar =
            document.getElementById(
                TOOLBAR_ID
            );

        if (toolbar) {
            return toolbar;
        }

        toolbar =
            document.createElement(
                'div'
            );

        toolbar.id =
            TOOLBAR_ID;

        Object.assign(
            toolbar.style,
            {
                position: 'fixed',
                top: TOOLBAR_TOP,
                left: TOOLBAR_LEFT,
                zIndex: '99999',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                pointerEvents: 'auto'
            }
        );

        document.body.appendChild(
            toolbar
        );

        return toolbar;
    }

    function createButtons() {
        const toolbar =
            createToolbar();

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

            styleButton(button);

            button.addEventListener(
                'click',
                event => {
                    /*
                     * Shift-click:
                     * reset chosen personal calendars.
                     */
                    if (event.shiftKey) {
                        event.preventDefault();

                        resetPrimaryCalendars();
                        return;
                    }

                    toggleMineOnly();
                }
            );

            toolbar.appendChild(
                button
            );
        }

        if (
            !document.getElementById(
                DIM_BUTTON_ID
            )
        ) {
            const button =
                document.createElement(
                    'button'
                );

            button.id =
                DIM_BUTTON_ID;

            button.type =
                'button';

            styleButton(button);

            /*
             * Hover = temporary dim.
             */
            button.addEventListener(
                'mouseenter',
                startDimHover
            );

            button.addEventListener(
                'mouseleave',
                endDimHover
            );

            /*
             * Click = lock/unlock dim mode.
             */
            button.addEventListener(
                'click',
                toggleDimLock
            );

            toolbar.appendChild(
                button
            );
        }

        updateButtons();
    }

    function updateButtons() {
        const mineButton =
            document.getElementById(
                BUTTON_ID
            );

        const dimButton =
            document.getElementById(
                DIM_BUTTON_ID
            );

        if (mineButton) {
            mineButton.disabled =
                busy;

            mineButton.textContent =
                busy
                    ? 'Working...'
                    : mineOnlyActive
                        ? 'Restore calendars'
                        : 'Mine only';
        }

        if (dimButton) {
            dimButton.disabled =
                busy;

            if (dimLocked) {
                dimButton.textContent =
                    'Undim others';
            } else {
                dimButton.textContent =
                    'Dim others';
            }

            dimButton.title =
                dimLocked
                    ? 'Click to restore other calendars. Hover keeps the preview active.'
                    : 'Hover to temporarily dim other calendars to 25%. Click to keep them dimmed.';
        }
    }

    /* -------------------------------------------------------
     * DEBUG
     * ----------------------------------------------------- */

    window.GCAL_MINE_ONLY_DEBUG =
        function () {
            const calendars =
                getCalendars();

            const primary =
                loadPrimaryCalendarIds() ||
                [];

            console.table(
                calendars.map(
                    (calendar, index) => ({
                        number:
                            index + 1,
                        name:
                            calendar.name,
                        calendarId:
                            calendar.id,
                        checked:
                            calendar.checked,
                        mine:
                            primary.includes(
                                calendar.id
                            )
                    })
                )
            );

            const events =
                getEventElements();

            console.table(
                events
                    .slice(0, 50)
                    .map(
                        (
                            event,
                            index
                        ) => ({
                            number:
                                index + 1,
                            calendarId:
                                getEventCalendarId(
                                    event
                                ),
                            dimmed:
                                event.classList
                                    .contains(
                                        DIM_CLASS
                                    )
                        })
                    )
            );

            return {
                calendars,
                events,
                dimLocked,
                dimHovered
            };
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
                    TOOLBAR_ID
                ) ||
                !document.getElementById(
                    BUTTON_ID
                ) ||
                !document.getElementById(
                    DIM_BUTTON_ID
                )
            ) {
                createButtons();
            }

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
