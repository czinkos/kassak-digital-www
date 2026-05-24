(function () {
    'use strict';

    if (!window.FACS_DATA || !window.FACS_DATA.length) return;

    const pages = window.FACS_DATA;

    // zone id → { pageIndex, imgWidth, imgHeight, imageUrl, ulx, uly, lrx, lry }
    const zoneMap = Object.create(null);
    pages.forEach(function (page, pageIndex) {
        const imageUrl = resolveUrl(page.imageUrl);
        page.zones.forEach(function (zone) {
            zoneMap[zone.id] = {
                pageIndex: pageIndex,
                imgWidth:  page.width,
                imgHeight: page.height,
                imageUrl:  imageUrl,
                ulx: zone.ulx, uly: zone.uly,
                lrx: zone.lrx, lry: zone.lry,
            };
        });
    });

    // zone id → plain text of that manuscript line (built from DOM after load)
    const lineTextMap = Object.create(null);

    let mode = 'none';
    let osdViewer = null;
    let currentPageIndex = 0;
    let osdLoadedPageIndex = -1;
    let osdReady = false;
    let pendingZone = null;
    let sideHighlightEl = null;

    // DOM elements
    const toolbar    = document.getElementById('facs-toolbar');
    const layout     = document.getElementById('facs-layout');
    const textCol    = document.getElementById('facs-text-col');
    const viewerCol  = document.getElementById('facs-viewer-col');
    const osdEl      = document.getElementById('facs-osd');
    const thumbsEl   = document.getElementById('facs-thumbs');
    const backBtn    = document.getElementById('facs-back-btn');
    const stripeEl   = document.getElementById('facs-stripe');
    const popupEl    = document.getElementById('facs-popup');

    function resolveUrl(rel) {
        return new URL(rel, document.baseURI).href;
    }

    function addCrosshairs(el, color) {
        const l = document.createElement('div');
        l.className = 'facs-crosshair facs-crosshair-l';
        if (color) l.style.backgroundColor = color;
        el.appendChild(l);
        const r = document.createElement('div');
        r.className = 'facs-crosshair facs-crosshair-r';
        if (color) r.style.backgroundColor = color;
        el.appendChild(r);
    }

    // ── mode switching ────────────────────────────────────────────────────────

    function setMode(newMode) {
        mode = newMode;
        document.documentElement.dataset.facsMode = newMode;
        toolbar.querySelectorAll('[data-mode]').forEach(function (btn) {
            btn.classList.toggle('active', btn.dataset.mode === newMode);
        });
        stripeEl.style.display = 'none';

        var url = new URL(location.href);
        if (newMode === 'none') { url.searchParams.delete('view'); }
        else { url.searchParams.set('view', newMode); }
        history.replaceState(null, '', url);

        if (newMode === 'side' || newMode === 'image') {
            viewerCol.style.display = '';
            initOsd(currentPageIndex);
            buildThumbs();
        } else {
            viewerCol.style.display = 'none';
            destroyOsd();
        }
    }

    // ── OSD lifecycle ─────────────────────────────────────────────────────────

    let osdLoadingEl = null;
    function showOsdLoading() {
        if (!osdLoadingEl) {
            osdLoadingEl = document.createElement('div');
            osdLoadingEl.className = 'facs-loading-overlay';
            osdLoadingEl.innerHTML = '<div class="facs-spinner"></div>';
        }
        osdEl.appendChild(osdLoadingEl);
    }
    function hideOsdLoading() {
        if (osdLoadingEl && osdLoadingEl.parentNode) {
            osdLoadingEl.parentNode.removeChild(osdLoadingEl);
        }
    }

    let osdErrorEl = null;
    function showOsdError() {
        hideOsdLoading();
        if (!osdErrorEl) {
            osdErrorEl = document.createElement('div');
            osdErrorEl.className = 'facs-error-message';
            osdErrorEl.textContent = 'Hiányzó fakszimile képfájl!';
        }
        osdEl.appendChild(osdErrorEl);
    }
    function hideOsdError() {
        if (osdErrorEl && osdErrorEl.parentNode) {
            osdErrorEl.parentNode.removeChild(osdErrorEl);
        }
    }

    function initOsd(pageIndex) {
        if (osdViewer) {
            loadPage(pageIndex);
            return;
        }
        osdReady = false;
        showOsdLoading();
        hideOsdError();
        const page = pages[pageIndex];
        osdViewer = OpenSeadragon({
            element: osdEl,
            prefixUrl: 'https://cdn.jsdelivr.net/npm/openseadragon@5/build/openseadragon/images/',
            tileSources: {
                type: 'image',
                url: resolveUrl(page.imageUrl),
                buildPyramid: false,
            },
            showNavigationControl: true,
            showFullPageControl: false,
            animationTime: 0.4,
            visibilityRatio: 0.5,
            maxZoomLevel: 10,
            defaultZoomLevel: 0,
            minZoomLevel: 0,
        });
        osdViewer.addHandler('open', function () {
            osdReady = true;
            hideOsdLoading();
            hideOsdError();
            osdLoadedPageIndex = pageIndex;
            currentPageIndex = pageIndex;

            sideHighlightEl = document.createElement('div');
            sideHighlightEl.className = 'facs-side-highlight';
            addCrosshairs(sideHighlightEl);
            osdViewer.addOverlay({
                element: sideHighlightEl,
                location: new OpenSeadragon.Rect(0, 0, 0, 0)
            });

            if (mode === 'image') addZoneOverlays(pageIndex);
            if (pendingZone && pendingZone.pageIndex === pageIndex) {
                panToZone(pendingZone);
                pendingZone = null;
            }
        });
        osdViewer.addHandler('open-failed', function () {
            showOsdError();
        });
    }

    function loadPage(pageIndex) {
        if (!osdViewer) return;
        osdReady = false;
        showOsdLoading();
        hideOsdError();
        osdViewer.clearOverlays();
        currentPageIndex = pageIndex;
        const page = pages[pageIndex];
        osdViewer.open({
            type: 'image',
            url: resolveUrl(page.imageUrl),
            buildPyramid: false,
        });
        osdViewer.addHandler('open', function handler() {
            osdViewer.removeHandler('open', handler);
            osdReady = true;
            hideOsdLoading();
            hideOsdError();
            osdLoadedPageIndex = pageIndex;
            updateThumbActive();
            if (mode === 'image') addZoneOverlays(pageIndex);
            if (pendingZone && pendingZone.pageIndex === pageIndex) {
                panToZone(pendingZone);
                pendingZone = null;
            }
        });
        osdViewer.addHandler('open-failed', function handler() {
            osdViewer.removeHandler('open-failed', handler);
            showOsdError();
        });
        updateThumbActive();
    }

    function destroyOsd() {
        if (osdViewer) {
            osdViewer.destroy();
            osdViewer = null;
            osdReady = false;
            osdLoadedPageIndex = -1;
        }
    }

    // ── thumbnails ────────────────────────────────────────────────────────────

    function buildThumbs() {
        thumbsEl.innerHTML = '';
        pages.forEach(function (page, i) {
            const btn = document.createElement('button');
            btn.className = 'facs-thumb' + (i === currentPageIndex ? ' active' : '');
            btn.title = (i + 1) + '. oldal';
            const img = document.createElement('img');
            img.src = resolveUrl(page.imageUrl);
            img.alt = (i + 1) + '. oldal';
            btn.appendChild(img);
            btn.addEventListener('click', function () {
                currentPageIndex = i;
                loadPage(i);
                updateThumbActive();
            });
            thumbsEl.appendChild(btn);
        });
    }

    function updateThumbActive() {
        thumbsEl.querySelectorAll('.facs-thumb').forEach(function (btn, i) {
            btn.classList.toggle('active', i === currentPageIndex);
        });
    }

    // ── stripe mode ───────────────────────────────────────────────────────────

    let stripeLoadingEl = null;
    function showStripeLoading() {
        if (!stripeLoadingEl) {
            stripeLoadingEl = document.createElement('div');
            stripeLoadingEl.className = 'facs-loading-overlay';
            stripeLoadingEl.innerHTML = '<div class="facs-spinner"></div>';
        }
        stripeEl.appendChild(stripeLoadingEl);
    }
    function hideStripeLoading() {
        if (stripeLoadingEl && stripeLoadingEl.parentNode) {
            stripeLoadingEl.parentNode.removeChild(stripeLoadingEl);
        }
    }

    let stripeErrorEl = null;
    function showStripeError() {
        hideStripeLoading();
        if (!stripeErrorEl) {
            stripeErrorEl = document.createElement('div');
            stripeErrorEl.className = 'facs-error-message';
            stripeErrorEl.textContent = 'Hiányzó fakszimile képfájl!';
        }
        stripeEl.appendChild(stripeErrorEl);
    }
    function hideStripeError() {
        if (stripeErrorEl && stripeErrorEl.parentNode) {
            stripeErrorEl.parentNode.removeChild(stripeErrorEl);
        }
    }

    const stripeImg = document.createElement('img');
    stripeEl.appendChild(stripeImg);

    const crosshairL = document.createElement('div');
    crosshairL.className = 'facs-stripe-crosshair facs-stripe-crosshair-l';
    stripeEl.appendChild(crosshairL);

    const crosshairR = document.createElement('div');
    crosshairR.className = 'facs-stripe-crosshair facs-stripe-crosshair-r';
    stripeEl.appendChild(crosshairR);

    function showStripe() {
        if (mode !== 'stripe') return;
        const zone = zoneMap[this.dataset.facs];
        if (!zone) return;

        const vw = window.innerWidth;
        const scale = zone.imgWidth > 0 ? vw / zone.imgWidth : 1;
        const baseStripeH = (zone.lry - zone.uly) * scale;
        const offset = baseStripeH * 0.10;
        const stripeH = baseStripeH + 2 * offset;

        showStripeLoading();
        hideStripeError();
        stripeImg.onload = function() {
            hideStripeLoading();
            hideStripeError();
            stripeImg.style.display = 'block';
        };
        stripeImg.onerror = function() {
            showStripeError();
            stripeImg.style.display = 'none';
        };
        stripeImg.src = zone.imageUrl;
        stripeImg.style.width = vw + 'px';
        stripeImg.style.top = -(zone.uly * scale - offset) + 'px';

        stripeEl.style.height = stripeH + 'px';

        const lineRect = this.getBoundingClientRect();
        const top = lineRect.top - stripeH - 6;
        stripeEl.style.top = (top > 0 ? top : lineRect.bottom + 6) + 'px';
        stripeEl.style.display = 'block';
    }

    function hideStripe() {
        stripeEl.style.display = 'none';
        hideStripeLoading();
        hideStripeError();
    }

    // ── side-by-side mode ─────────────────────────────────────────────────────

    function panToZone(zone) {
        if (!osdViewer || !osdReady) return;
        const tiledImage = osdViewer.world.getItemAt(0);
        if (!tiledImage) return;

        const page = pages[zone.pageIndex];
        const contentSize = tiledImage.getContentSize();
        const scaleX = contentSize.x / page.width;
        const scaleY = contentSize.y / page.height;

        const baseW = (zone.lrx - zone.ulx) * scaleX;
        const baseH = (zone.lry - zone.uly) * scaleY;
        const offX = baseW * 0.01;
        const offY = baseH * 0.10;

        const rect = tiledImage.imageToViewportRectangle(
            zone.ulx * scaleX - offX,
            zone.uly * scaleY - offY,
            baseW + 2 * offX,
            baseH + 2 * offY
        );

        if (sideHighlightEl) {
            osdViewer.updateOverlay(sideHighlightEl, rect);
            sideHighlightEl.style.display = 'block';
        }

        const padX = rect.width * 0.05;
        const padY = rect.height * 0.05;
        const fitRect = new OpenSeadragon.Rect(
            rect.x - padX,
            rect.y - padY,
            rect.width + 2 * padX,
            rect.height + 2 * padY
        );
        osdViewer.viewport.fitBoundsWithConstraints(fitRect, false);
    }

    // ── image-only mode overlays ──────────────────────────────────────────────

    function addZoneOverlays(pageIndex) {
        if (!osdViewer) return;
        const tiledImage = osdViewer.world.getItemAt(0);
        if (!tiledImage) return;

        const page = pages[pageIndex];
        const contentSize = tiledImage.getContentSize();
        const scaleX = contentSize.x / page.width;
        const scaleY = contentSize.y / page.height;

        page.zones.forEach(function (zone) {
            if (!lineTextMap[zone.id]) return;
            const el = document.createElement('div');
            el.className = 'facs-zone-overlay';
            addCrosshairs(el);
            
            el.addEventListener('mouseenter', function (ev) {
                popupEl.innerHTML = lineTextMap[zone.id];
                popupEl.querySelectorAll('details').forEach(d => d.open = true);
                popupEl.style.display = 'block';

                const rect = el.getBoundingClientRect();
                const popW = popupEl.offsetWidth;
                const popH = popupEl.offsetHeight;
                
                let left = rect.left;
                if (left + popW > window.innerWidth - 8) {
                    left = window.innerWidth - popW - 8;
                }
                if (left < 8) left = 8;
                
                let top = rect.bottom + 8;
                if (top + popH > window.innerHeight - 8) {
                    top = rect.top - popH - 8;
                }
                
                popupEl.style.left = left + 'px';
                popupEl.style.top  = top + 'px';
            });
            
            el.addEventListener('mouseleave', function () {
                popupEl.style.display = 'none';
            });

            const baseW = (zone.lrx - zone.ulx) * scaleX;
            const baseH = (zone.lry - zone.uly) * scaleY;
            const offX = baseW * 0.01;
            const offY = baseH * 0.10;

            osdViewer.addOverlay({
                element: el,
                location: tiledImage.imageToViewportRectangle(
                    zone.ulx * scaleX - offX,
                    zone.uly * scaleY - offY,
                    baseW + 2 * offX,
                    baseH + 2 * offY
                ),
            });
        });
    }

    function movePopup(e) {
        const x = e.clientX + 14;
        const y = e.clientY - 36;
        popupEl.style.left = Math.min(x, window.innerWidth - popupEl.offsetWidth - 8) + 'px';
        popupEl.style.top  = Math.max(y, 8) + 'px';
    }

    // ── page tracking via pb markers ─────────────────────────────────────────

    function trackPageScroll() {
        if (!thumbsEl.children.length) return;
        const hrs = document.querySelectorAll('hr[data-facs-page]');
        if (!hrs.length) return;
        const mid = window.innerHeight / 2;
        let activePage = null;
        hrs.forEach(function (hr) {
            const rect = hr.getBoundingClientRect();
            if (rect.top <= mid) activePage = hr.dataset.facsPage;
        });
        if (!activePage) return;
        const pageIndex = pages.findIndex(function (p) { return p.id === activePage; });
        if (pageIndex !== -1 && pageIndex !== currentPageIndex) {
            currentPageIndex = pageIndex;
            updateThumbActive();
        }
    }

    // ── init ──────────────────────────────────────────────────────────────────

    document.addEventListener('DOMContentLoaded', function () {
        // build line text map from rendered spans
        document.querySelectorAll('.tei-line[data-facs]').forEach(function (el) {
            lineTextMap[el.dataset.facs] = el.innerHTML;
        });

        // stripe: attach hover handlers to all line spans
        document.querySelectorAll('.tei-line[data-facs]').forEach(function (el) {
            el.addEventListener('mouseenter', showStripe);
            el.addEventListener('mouseleave', hideStripe);
        });

        // side mode: line hover → pan OSD
        document.querySelectorAll('.tei-line[data-facs]').forEach(function (el) {
            el.addEventListener('mouseenter', function () {
                if (mode !== 'side') return;
                const zone = zoneMap[this.dataset.facs];
                if (!zone) return;
                if (zone.pageIndex !== osdLoadedPageIndex) {
                    pendingZone = zone;
                    loadPage(zone.pageIndex);
                } else if (osdReady) {
                    panToZone(zone);
                } else {
                    pendingZone = zone;
                }
            });
        });

        // toolbar buttons
        toolbar.querySelectorAll('[data-mode]').forEach(function (btn) {
            btn.addEventListener('click', function () { setMode(this.dataset.mode); });
        });

        // back button in image-only mode
        if (backBtn) backBtn.addEventListener('click', function () { setMode('none'); });

        // page tracking on scroll (updates thumbnail highlight)
        window.addEventListener('scroll', trackPageScroll, { passive: true });

        // restore view mode from URL param
        var viewParam = new URLSearchParams(location.search).get('view');
        if (viewParam && ['stripe', 'side', 'image'].includes(viewParam)) {
            setMode(viewParam);
        }
    });

})();
