/**
 * EcoCart Supermarket 3D — ES module (Three.js via import map).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let renderer;
let scene;
let camera;
let controls;
let initialized = false;
let animFrameId = null;
let storeData = null;
let productMeshes = [];
const labelSprites = [];
let uiWired = false;

let routeLine = null;
let routeSphere = null;
let routeCurve = null;
let routeAnimT = 0;
const stopMarkers = [];

const RAY = new THREE.Raycaster();
const POINTER = new THREE.Vector2();

// ============ FIRST PERSON MODE ============
let fpMode = false;
let fpMoveForward = false;
let fpMoveBackward = false;
let fpMoveLeft = false;
let fpMoveRight = false;
let fpYaw = 0;
let fpPitch = 0;
let fpLookDragging = false;
let fpLastMouseX = 0;
let fpLastMouseY = 0;
const fpHeight = 1.7;
let fpSpeed = 12;
const fpSprintMultiplier = 1.8;
let fpSprinting = false;
const fpPosition = new THREE.Vector3(35, fpHeight, 58);
let fpBobPhase = 0;
const fpBobAmount = 0.03;
let loopPrevTime = performance.now();
let collisionBoxes = [];
let autoWalking = false;
let autoWalkIndex = 0;
let autoWalkProgress = 0;
let fpTouchId = null;
let fpTouchStartX = 0;
let fpTouchStartY = 0;
let fpMoveTouchId = null;

function getContainer() {
    return document.getElementById('supermarket-canvas-container');
}

// ============ INIT ============
function init() {
    const section = document.getElementById('view-supermarket');
    if (section && !section.classList.contains('active')) return;

    if (initialized) {
        startLoop();
        onResize();
        return;
    }

    const container = getContainer();
    if (!container) {
        console.error('No #supermarket-canvas-container');
        return;
    }

    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) {
        console.warn('Supermarket container has no size, retrying…');
        setTimeout(init, 100);
        return;
    }

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf5f0e8);
    scene.fog = new THREE.FogExp2(0xf5f0e8, 0.008);

    camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 300);
    camera.position.set(40, 55, 80);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    container.insertBefore(renderer.domElement, container.firstChild);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.borderRadius = '12px';

    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(40, 0, 30);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 15;
    controls.maxDistance = 110;
    controls.maxPolarAngle = Math.PI / 2.1;
    controls.update();
    camera.lookAt(40, 0, 30);

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(50, 60, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -50;
    sun.shadow.camera.right = 50;
    sun.shadow.camera.top = 50;
    sun.shadow.camera.bottom = -50;
    scene.add(sun);
    scene.add(new THREE.HemisphereLight(0xdcedc8, 0x8d6e63, 0.3));

    const floorGeo = new THREE.PlaneGeometry(80, 60);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0xede8dd, roughness: 0.9 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(40, -0.01, 30);
    floor.receiveShadow = true;
    scene.add(floor);

    const gridHelper = new THREE.GridHelper(80, 40, 0xddd8cc, 0xddd8cc);
    gridHelper.position.set(40, 0.01, 30);
    const gMat = gridHelper.material;
    if (Array.isArray(gMat)) {
        gMat.forEach((m) => {
            m.transparent = true;
            m.opacity = 0.3;
        });
    } else {
        gMat.transparent = true;
        gMat.opacity = 0.3;
    }
    scene.add(gridHelper);

    buildStoreGeometry();

    fetch('/api/supermarket/layout')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('layout HTTP ' + r.status))))
        .then((data) => {
            storeData = data;
            buildProducts(data);
            buildCategoryFilters(data);
        })
        .catch((err) => {
            console.warn('Layout API failed, floor geometry only:', err);
            buildCategoryFilters(null);
        });

    window.addEventListener('resize', onResize);
    renderer.domElement.addEventListener('click', onCanvasClick);

    if (!uiWired) {
        wireUi();
        uiWired = true;
    }

    initialized = true;
    startLoop();
    populateItemChecklist();
    console.log('Supermarket 3D initialized');
}

function wireUi() {
    document.getElementById('sm-show-route')?.addEventListener('change', (e) => {
        const on = e.target.checked;
        if (routeLine) routeLine.visible = on;
        if (routeSphere) routeSphere.visible = on;
        stopMarkers.forEach((m) => {
            m.visible = on;
        });
    });

    document.getElementById('sm-show-labels')?.addEventListener('change', (e) => {
        const on = e.target.checked;
        labelSprites.forEach((s) => {
            s.visible = on;
        });
    });

    document.getElementById('sm-eco-picks')?.addEventListener('change', (e) => {
        applyEcoHighlight(e.target.checked);
    });

    document.getElementById('sm-category-filters')?.addEventListener('change', () => {
        const off = new Set(
            [...document.querySelectorAll('#sm-category-filters input[type=checkbox]:not(:checked)')].map(
                (x) => x.dataset.category
            )
        );
        productMeshes.forEach((mesh) => {
            const cat = mesh.userData.category || 'Other';
            mesh.visible = !off.has(cat);
        });
    });

    document.getElementById('sm-item-source')?.addEventListener('change', () => populateItemChecklist());

    document.getElementById('sm-generate-route')?.addEventListener('click', async () => {
        const ids = [...document.querySelectorAll('#sm-item-checklist input.sm-route-cb:checked')].map((x) => x.dataset.pid);
        if (!ids.length) {
            alert('Select at least one product.');
            return;
        }
        if (!scene) return;
        const res = await fetch('/api/supermarket/route', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ product_ids: ids }),
        });
        const data = await res.json();
        if (!res.ok) {
            alert(data.error || 'Route failed');
            return;
        }
        renderRoute(data);
        const side = document.getElementById('sm-route-stops');
        if (side) {
            side.innerHTML = data.stops
                .map(
                    (s) =>
                        `<div class="sm-stop-row" data-x="${s.x}" data-z="${s.z}" style="padding:6px;margin:4px 0;border-radius:8px;cursor:pointer;border:1px solid #e5e7eb;font-size:0.8rem;"><strong>#${s.stop_number}</strong> ${escapeHtml(s.product_name)}<br><span style="color:#9ca3af;font-size:0.7rem">${escapeHtml(s.zone_name)}</span></div>`
                )
                .join('');
            side.querySelectorAll('.sm-stop-row').forEach((row) => {
                row.addEventListener('click', () => {
                    if (fpMode) return;
                    const x = parseFloat(row.dataset.x);
                    const z = parseFloat(row.dataset.z);
                    animateCameraTo(new THREE.Vector3(x + 8, 28, z + 12), new THREE.Vector3(x, 0, z));
                });
            });
        }
    });

    document.getElementById('sm-mode-overview')?.addEventListener('click', () => exitFirstPerson());
    document.getElementById('sm-mode-firstperson')?.addEventListener('click', () => enterFirstPerson());
}

function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

async function populateItemChecklist() {
    const list = document.getElementById('sm-item-checklist');
    if (!list) return;
    const wantSmart = window.smartListItemsForStore;
    const sourceEl = document.getElementById('sm-item-source');
    if (wantSmart?.length && sourceEl) {
        sourceEl.value = 'custom';
    }
    list.innerHTML = '<p style="color:#9ca3af;font-size:0.85em;margin:0;">Loading…</p>';
    const mode = sourceEl?.value || 'latest';
    try {
        let html = '';
        if (mode === 'latest' && !wantSmart?.length) {
            const res = await fetch('/api/supermarket/latest-receipt-items');
            const data = res.ok ? await res.json() : { items: [] };
            if (data.items?.length) {
                data.items.forEach((it) => {
                    const pid = it.layout_product_id;
                    if (!pid) return;
                    html += `<label style="display:flex;gap:8px;align-items:flex-start;margin:6px 0;font-size:0.78rem;cursor:pointer;"><input type="checkbox" class="sm-route-cb" data-pid="${pid}" checked/> <span>${escapeHtml(it.name)} <span style="color:#9ca3af">(${it.kg_co2e} kg)</span></span></label>`;
                });
            }
        }
        if (!html) {
            let L = storeData;
            if (!L?.zones) {
                const lr = await fetch('/api/supermarket/layout');
                if (lr.ok) L = await lr.json();
            }
            const plist = [];
            L?.zones?.forEach((z) => {
                z.products?.forEach((p) => plist.push(p));
            });
            plist.forEach((p) => {
                html += `<label style="display:flex;gap:8px;align-items:flex-start;margin:6px 0;font-size:0.78rem;cursor:pointer;"><input type="checkbox" class="sm-route-cb" data-pid="${p.id}"/> <span>${escapeHtml(p.name)}</span></label>`;
            });
        }
        list.innerHTML = html || '<p style="color:#9ca3af;font-size:0.85em;">No items</p>';
        if (wantSmart?.length && html) {
            list.querySelectorAll('label').forEach((label) => {
                const cb = label.querySelector('.sm-route-cb');
                if (!cb) return;
                const text = (label.textContent || '').toLowerCase();
                const hit = wantSmart.some((n) => n && text.includes(String(n).toLowerCase()));
                cb.checked = hit;
            });
            window.smartListItemsForStore = null;
        }
    } catch {
        list.innerHTML = '<p style="color:#9ca3af;font-size:0.85em;">Could not load items.</p>';
    }
}

function applyEcoHighlight(on) {
    productMeshes.forEach((mesh) => {
        const rec = mesh.userData.is_recommended;
        const mat = mesh.material;
        if (!(mat instanceof THREE.MeshStandardMaterial)) return;
        if (on && !rec) {
            mat.color.multiplyScalar(0.35);
            mat.emissiveIntensity = 0;
        } else {
            const kg = mesh.userData.kg_co2e || 0;
            mat.color.set(rec ? 0x22c55e : kg > 8 ? 0xef4444 : 0xeab308);
            mat.emissive.set(rec ? 0x22c55e : 0x000000);
            mat.emissiveIntensity = rec ? 0.3 : 0;
        }
    });
}

function onCanvasClick(event) {
    if (fpMode) return;
    if (!camera || !scene || !productMeshes.length) return;
    const container = getContainer();
    if (!container) return;
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    POINTER.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    POINTER.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    RAY.setFromCamera(POINTER, camera);
    const hits = RAY.intersectObjects(productMeshes, false);
    if (!hits.length) {
        hideProductPopup();
        return;
    }
    const p = hits[0].object.userData;
    const popup = document.getElementById('sm-product-popup');
    if (!popup) return;
    let html = `<strong style="font-size:0.95rem;">${escapeHtml(p.name || '')}</strong>`;
    if (p.brand) html += `<p style="margin:6px 0;font-size:0.85rem;color:#4a5c4a;">${escapeHtml(p.brand)}</p>`;
    html += `<p style="margin:0;"><strong>${p.kg_co2e} kg CO2e</strong></p>`;
    if (p.zone_name) html += `<p style="font-size:0.8rem;color:#9ca3af;margin:6px 0 0;">${escapeHtml(p.zone_name)}</p>`;
    html += `<button type="button" id="sm-popup-close" style="margin-top:10px;padding:6px 12px;border:1px solid #d3e0d4;border-radius:8px;background:#fff;cursor:pointer;font-family:Outfit,sans-serif;font-size:0.85rem;">Close</button>`;
    popup.innerHTML = html;
    popup.style.display = 'block';
    popup.style.left = `${Math.min(event.clientX - container.getBoundingClientRect().left + 12, container.clientWidth - 280)}px`;
    popup.style.top = `${Math.min(event.clientY - container.getBoundingClientRect().top + 12, container.clientHeight - 200)}px`;
    document.getElementById('sm-popup-close')?.addEventListener('click', hideProductPopup);
}

function hideProductPopup() {
    const popup = document.getElementById('sm-product-popup');
    if (popup) {
        popup.style.display = 'none';
        popup.innerHTML = '';
    }
}

function buildCollisionBoxes() {
    collisionBoxes = [];
    collisionBoxes.push({ minX: -1, maxX: 81, minZ: -1, maxZ: 0.5 });
    collisionBoxes.push({ minX: -1, maxX: 0.5, minZ: -1, maxZ: 61 });
    collisionBoxes.push({ minX: 79.5, maxX: 81, minZ: -1, maxZ: 61 });
    collisionBoxes.push({ minX: -1, maxX: 17.5, minZ: 59.5, maxZ: 61 });
    collisionBoxes.push({ minX: 54.5, maxX: 81, minZ: 59.5, maxZ: 61 });
    for (let i = 0; i < 6; i++) {
        const z = 12 + i * 5;
        collisionBoxes.push({ minX: 18, maxX: 56, minZ: z - 1.05, maxZ: z - 0.45 });
        collisionBoxes.push({ minX: 18, maxX: 56, minZ: z + 0.45, maxZ: z + 1.05 });
    }
    collisionBoxes.push({ minX: 0.5, maxX: 18, minZ: 28, maxZ: 50 });
    collisionBoxes.push({ minX: 0.5, maxX: 12, minZ: 6, maxZ: 32 });
    collisionBoxes.push({ minX: 24, maxX: 56, minZ: 0.5, maxZ: 4.5 });
    collisionBoxes.push({ minX: 64, maxX: 74, minZ: 12, maxZ: 42 });
    collisionBoxes.push({ minX: 28, maxX: 50, minZ: 44, maxZ: 53 });
    collisionBoxes.push({ minX: 56, maxX: 80, minZ: 0.5, maxZ: 13 });
}

function checkWorldBounds(x, z, radius) {
    if (x - radius < 0.5 || x + radius > 79.5 || z - radius < 0.5) return true;
    if (z + radius > 59.5) {
        if (x - radius < 17.5 || x + radius > 54.5) return true;
    }
    return false;
}

function checkCollision(newX, newZ, radius) {
    if (checkWorldBounds(newX, newZ, radius)) return true;
    for (const box of collisionBoxes) {
        const cx = Math.max(box.minX, Math.min(newX, box.maxX));
        const cz = Math.max(box.minZ, Math.min(newZ, box.maxZ));
        const dx = newX - cx;
        const dz = newZ - cz;
        if (dx * dx + dz * dz < radius * radius) return true;
    }
    return false;
}

function updateFPCamera() {
    if (!camera) return;
    camera.rotation.set(fpPitch, fpYaw, 0, 'YXZ');
}

function getWalkRouteParent() {
    if (fpMode) return document.getElementById('fp-route-actions');
    return document.getElementById('sm-route-info');
}

function maybeAddFpWalkButton() {
    document.getElementById('sm-fp-walk-route')?.remove();
    if (!window.currentRouteWaypoints || window.currentRouteWaypoints.length < 2) return;
    const parent = getWalkRouteParent();
    if (!parent) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'sm-fp-walk-route';
    btn.textContent = '🚶 Walk the Route';
    btn.style.cssText =
        'width:100%;margin-top:10px;padding:10px;background:#4f772d;color:white;border:none;border-radius:8px;cursor:pointer;font-family:Outfit,sans-serif;font-weight:600;font-size:0.85em;';
    btn.addEventListener('click', () => startAutoWalk());
    parent.appendChild(btn);
}

function fpKeyDown(e) {
    if (!fpMode) return;
    switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
            fpMoveForward = true;
            break;
        case 'KeyS':
        case 'ArrowDown':
            fpMoveBackward = true;
            break;
        case 'KeyA':
        case 'ArrowLeft':
            fpMoveLeft = true;
            break;
        case 'KeyD':
        case 'ArrowRight':
            fpMoveRight = true;
            break;
        case 'ShiftLeft':
        case 'ShiftRight':
            fpSprinting = true;
            break;
        case 'Escape':
            exitFirstPerson();
            break;
        default:
            return;
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
    }
}

function fpKeyUp(e) {
    if (!fpMode) return;
    switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
            fpMoveForward = false;
            break;
        case 'KeyS':
        case 'ArrowDown':
            fpMoveBackward = false;
            break;
        case 'KeyA':
        case 'ArrowLeft':
            fpMoveLeft = false;
            break;
        case 'KeyD':
        case 'ArrowRight':
            fpMoveRight = false;
            break;
        case 'ShiftLeft':
        case 'ShiftRight':
            fpSprinting = false;
            break;
        default:
            break;
    }
}

function fpMouseDownHandler(e) {
    if (!fpMode || e.button !== 0) return;
    fpLookDragging = true;
    fpLastMouseX = e.clientX;
    fpLastMouseY = e.clientY;
    renderer.domElement.style.cursor = 'none';
}

function fpMouseUpHandler() {
    fpLookDragging = false;
    if (fpMode && renderer) renderer.domElement.style.cursor = 'crosshair';
}

function fpMouseMoveHandler(e) {
    if (!fpMode || !fpLookDragging) return;
    const sensitivity = 0.003;
    const deltaX = e.clientX - fpLastMouseX;
    const deltaY = e.clientY - fpLastMouseY;
    fpYaw -= deltaX * sensitivity;
    fpPitch -= deltaY * sensitivity;
    fpPitch = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, fpPitch));
    fpLastMouseX = e.clientX;
    fpLastMouseY = e.clientY;
    updateFPCamera();
}

function fpWheelHandler(e) {
    if (!fpMode) return;
    fpSpeed = Math.max(5, Math.min(25, fpSpeed + (e.deltaY > 0 ? -1 : 1)));
    e.preventDefault();
}

function fpTouchStart(e) {
    if (!fpMode) return;
    e.preventDefault();
    for (const touch of e.changedTouches) {
        const rect = renderer.domElement.getBoundingClientRect();
        const x = touch.clientX - rect.left;
        if (x < rect.width / 2) {
            fpMoveTouchId = touch.identifier;
            fpTouchStartX = touch.clientX;
            fpTouchStartY = touch.clientY;
        } else {
            fpTouchId = touch.identifier;
            fpLastMouseX = touch.clientX;
            fpLastMouseY = touch.clientY;
        }
    }
}

function fpTouchMove(e) {
    if (!fpMode) return;
    e.preventDefault();
    for (const touch of e.changedTouches) {
        if (touch.identifier === fpTouchId) {
            const sensitivity = 0.004;
            fpYaw -= (touch.clientX - fpLastMouseX) * sensitivity;
            fpPitch -= (touch.clientY - fpLastMouseY) * sensitivity;
            fpPitch = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, fpPitch));
            fpLastMouseX = touch.clientX;
            fpLastMouseY = touch.clientY;
            updateFPCamera();
        }
        if (touch.identifier === fpMoveTouchId) {
            const dx = touch.clientX - fpTouchStartX;
            const dy = touch.clientY - fpTouchStartY;
            const deadzone = 15;
            fpMoveForward = dy < -deadzone;
            fpMoveBackward = dy > deadzone;
            fpMoveLeft = dx < -deadzone;
            fpMoveRight = dx > deadzone;
        }
    }
}

function fpTouchEnd(e) {
    for (const touch of e.changedTouches) {
        if (touch.identifier === fpMoveTouchId) {
            fpMoveTouchId = null;
            fpMoveForward = fpMoveBackward = fpMoveLeft = fpMoveRight = false;
        }
        if (touch.identifier === fpTouchId) {
            fpTouchId = null;
        }
    }
}

function checkProductProximity() {
    if (!fpMode || !productMeshes?.length) return;
    const proximityThreshold = 2.5;
    let closestProduct = null;
    let closestDist = Infinity;
    for (const mesh of productMeshes) {
        if (!mesh.visible) continue;
        const dx = fpPosition.x - mesh.position.x;
        const dz = fpPosition.z - mesh.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < proximityThreshold && dist < closestDist) {
            closestDist = dist;
            closestProduct = mesh.userData;
        }
    }
    const popup = document.getElementById('fp-product-popup');
    if (!popup) return;
    if (closestProduct) {
        const p = closestProduct;
        const co2Color = p.is_recommended ? '#22c55e' : p.kg_co2e > 8 ? '#ef4444' : '#eab308';
        const kg = p.kg_co2e != null ? Number(p.kg_co2e).toFixed(2) : '—';
        popup.innerHTML = `
            <div style="font-weight:700; font-size:1em; margin-bottom:4px;">${escapeHtml(p.name || 'Item')}</div>
            <div style="color:#6b7280; font-size:0.85em; margin-bottom:6px;">${escapeHtml(
                [p.brand, p.zone_name].filter(Boolean).join(' · ')
            )}</div>
            <div style="display:flex; align-items:center; gap:6px; justify-content:center;">
                <span style="width:10px;height:10px;border-radius:50%;background:${co2Color};display:inline-block;"></span>
                <span style="font-weight:600;">${kg} kg CO₂e</span>
            </div>
            ${
                p.is_recommended
                    ? '<div style="margin-top:6px;padding:4px 8px;background:#f0fdf4;color:#166534;border-radius:6px;font-size:0.8em;font-weight:600;">✓ Eco Pick</div>'
                    : ''
            }`;
        popup.style.display = 'block';
    } else {
        popup.style.display = 'none';
    }
}

function showFPHud() {
    hideFPHud();
    const container = getContainer();
    if (!container) return;

    const routeActions = document.createElement('div');
    routeActions.id = 'fp-route-actions';
    routeActions.style.cssText =
        'position:absolute;bottom:168px;left:50%;transform:translateX(-50%);z-index:20;min-width:200px;max-width:90%;pointer-events:auto;';
    container.appendChild(routeActions);

    const crosshair = document.createElement('div');
    crosshair.id = 'fp-crosshair';
    crosshair.style.cssText =
        'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:20;pointer-events:none;';
    crosshair.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" style="opacity:0.5;">
            <circle cx="12" cy="12" r="2" fill="none" stroke="#132a13" stroke-width="1.5"/>
            <line x1="12" y1="4" x2="12" y2="9" stroke="#132a13" stroke-width="1.5" stroke-linecap="round"/>
            <line x1="12" y1="15" x2="12" y2="20" stroke="#132a13" stroke-width="1.5" stroke-linecap="round"/>
            <line x1="4" y1="12" x2="9" y2="12" stroke="#132a13" stroke-width="1.5" stroke-linecap="round"/>
            <line x1="15" y1="12" x2="20" y2="12" stroke="#132a13" stroke-width="1.5" stroke-linecap="round"/>
        </svg>`;
    container.appendChild(crosshair);

    const popup = document.createElement('div');
    popup.id = 'fp-product-popup';
    popup.style.cssText =
        'display:none;position:absolute;bottom:100px;left:50%;transform:translateX(-50%);z-index:20;background:rgba(255,255,255,0.95);backdrop-filter:blur(10px);border-radius:12px;padding:14px 20px;box-shadow:0 4px 20px rgba(0,0,0,0.15);min-width:220px;text-align:center;font-family:Outfit,sans-serif;pointer-events:none;';
    container.appendChild(popup);

    const hint = document.createElement('div');
    hint.id = 'fp-controls-hint';
    hint.style.cssText =
        'position:absolute;bottom:20px;left:50%;transform:translateX(-50%);z-index:20;background:rgba(19,42,19,0.8);backdrop-filter:blur(8px);border-radius:10px;padding:10px 20px;font-family:Outfit,sans-serif;font-size:0.8em;color:white;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:center;max-width:95%;pointer-events:none;';
    hint.innerHTML = `
        <span><kbd style="background:rgba(255,255,255,0.2);padding:2px 6px;border-radius:4px;">W</kbd><kbd style="background:rgba(255,255,255,0.2);padding:2px 6px;border-radius:4px;margin-left:2px;">A</kbd><kbd style="background:rgba(255,255,255,0.2);padding:2px 6px;border-radius:4px;margin-left:2px;">S</kbd><kbd style="background:rgba(255,255,255,0.2);padding:2px 6px;border-radius:4px;margin-left:2px;">D</kbd> Move</span>
        <span>🖱️ Drag to look</span>
        <span><kbd style="background:rgba(255,255,255,0.2);padding:2px 6px;border-radius:4px;">Shift</kbd> Sprint</span>
        <span><kbd style="background:rgba(255,255,255,0.2);padding:2px 6px;border-radius:4px;">Esc</kbd> Exit</span>
        <span style="opacity:0.85;font-size:0.75em;">Scroll: speed</span>`;
    container.appendChild(hint);

    const minimap = document.createElement('canvas');
    minimap.id = 'fp-minimap';
    minimap.width = 160;
    minimap.height = 120;
    minimap.style.cssText =
        'position:absolute;top:136px;right:16px;z-index:20;border-radius:10px;border:2px solid rgba(255,255,255,0.85);box-shadow:0 2px 12px rgba(0,0,0,0.2);background:#f5f0e8;';
    container.appendChild(minimap);

    if (renderer) renderer.domElement.style.cursor = 'crosshair';

    setTimeout(() => {
        const h = document.getElementById('fp-controls-hint');
        if (h && h.parentNode) {
            h.style.transition = 'opacity 1s';
            h.style.opacity = '0';
            setTimeout(() => h.remove(), 1000);
        }
    }, 5000);
}

function hideFPHud() {
    ['fp-crosshair', 'fp-product-popup', 'fp-controls-hint', 'fp-minimap', 'fp-route-actions'].forEach((id) => {
        document.getElementById(id)?.remove();
    });
    if (renderer) renderer.domElement.style.cursor = 'grab';
}

function updateMinimap() {
    const canvas = document.getElementById('fp-minimap');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const scaleX = w / 80;
    const scaleZ = h / 60;
    ctx.fillStyle = '#f5f0e8';
    ctx.fillRect(0, 0, w, h);
    const zones = [
        { color: '#22c55e', x: 0, z: 32, wd: 18, d: 18 },
        { color: '#dc2626', x: 0, z: 8, wd: 12, d: 22 },
        { color: '#3b82f6', x: 24, z: 0, wd: 32, d: 7 },
        { color: '#a78bfa', x: 64, z: 12, wd: 10, d: 30 },
        { color: '#fbbf24', x: 12, z: 0, wd: 16, d: 12 },
        { color: '#9ca3af', x: 28, z: 44, wd: 22, d: 10 },
    ];
    zones.forEach((z) => {
        ctx.fillStyle = z.color + '40';
        ctx.fillRect(z.x * scaleX, z.z * scaleZ, z.wd * scaleX, z.d * scaleZ);
        ctx.strokeStyle = z.color;
        ctx.lineWidth = 1;
        ctx.strokeRect(z.x * scaleX, z.z * scaleZ, z.wd * scaleX, z.d * scaleZ);
    });
    ctx.fillStyle = 'rgba(139,115,85,0.45)';
    for (let i = 0; i < 6; i++) {
        const zz = 12 + i * 5;
        ctx.fillRect(18 * scaleX, (zz - 0.5) * scaleZ, 38 * scaleX, 1 * scaleZ);
    }
    const px = fpPosition.x * scaleX;
    const pz = fpPosition.z * scaleZ;
    ctx.save();
    ctx.translate(px, pz);
    ctx.rotate(-fpYaw + Math.PI / 2);
    ctx.fillStyle = 'rgba(79, 119, 45, 0.18)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-12, -20);
    ctx.lineTo(12, -20);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#4f772d';
    ctx.beginPath();
    ctx.moveTo(0, -5);
    ctx.lineTo(-3, 3);
    ctx.lineTo(3, 3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    const wps = window.currentRouteWaypoints;
    if (wps?.length > 1) {
        ctx.strokeStyle = '#22c55e';
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        wps.forEach((wp, i) => {
            const mx = wp.x * scaleX;
            const mz = wp.z * scaleZ;
            if (i === 0) ctx.moveTo(mx, mz);
            else ctx.lineTo(mx, mz);
        });
        ctx.stroke();
        ctx.setLineDash([]);
    }
}

function startAutoWalk() {
    if (!window.currentRouteWaypoints || window.currentRouteWaypoints.length < 2) return;
    autoWalking = true;
    autoWalkIndex = 0;
    autoWalkProgress = 0;
    const start = window.currentRouteWaypoints[0];
    fpPosition.set(start.x, fpHeight, start.z);
    fpMoveForward = fpMoveBackward = fpMoveLeft = fpMoveRight = false;
    hideProductPopup();
}

function updateAutoWalk(delta) {
    if (!autoWalking || !window.currentRouteWaypoints?.length) return;
    const waypoints = window.currentRouteWaypoints;
    if (autoWalkIndex >= waypoints.length - 1) {
        autoWalking = false;
        const last = waypoints[waypoints.length - 1];
        fpPosition.set(last.x, fpHeight, last.z);
        camera.position.copy(fpPosition);
        updateFPCamera();
        checkProductProximity();
        return;
    }
    const from = waypoints[autoWalkIndex];
    const to = waypoints[autoWalkIndex + 1];
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const segmentLength = Math.sqrt(dx * dx + dz * dz) || 0.1;
    const walkSpeed = 6;
    autoWalkProgress += (walkSpeed * delta) / segmentLength;
    if (autoWalkProgress >= 1) {
        autoWalkProgress = 0;
        autoWalkIndex++;
        if (autoWalkIndex >= waypoints.length - 1) {
            autoWalking = false;
            fpPosition.set(to.x, fpHeight, to.z);
        } else {
            fpPosition.set(to.x, fpHeight, to.z);
        }
        camera.position.copy(fpPosition);
        updateFPCamera();
        checkProductProximity();
        return;
    }
    fpPosition.x = from.x + dx * autoWalkProgress;
    fpPosition.z = from.z + dz * autoWalkProgress;
    fpPosition.y = fpHeight + Math.sin(autoWalkProgress * Math.PI * 4) * 0.02;
    const targetYaw = Math.atan2(-dx, -dz);
    let diff = targetYaw - fpYaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    fpYaw += diff * Math.min(1, delta * 5);
    camera.position.copy(fpPosition);
    updateFPCamera();
    checkProductProximity();
}

function updateFirstPerson(delta) {
    if (!fpMode || autoWalking) return;
    const speed = fpSpeed * (fpSprinting ? fpSprintMultiplier : 1.0);
    const forward = new THREE.Vector3(0, 0, -1);
    forward.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, fpYaw, 0, 'YXZ')));
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3();
    right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    let moveX = 0;
    let moveZ = 0;
    if (fpMoveForward) {
        moveX += forward.x * speed * delta;
        moveZ += forward.z * speed * delta;
    }
    if (fpMoveBackward) {
        moveX -= forward.x * speed * delta;
        moveZ -= forward.z * speed * delta;
    }
    if (fpMoveLeft) {
        moveX -= right.x * speed * delta;
        moveZ -= right.z * speed * delta;
    }
    if (fpMoveRight) {
        moveX += right.x * speed * delta;
        moveZ += right.z * speed * delta;
    }
    const radius = 0.4;
    const newX = fpPosition.x + moveX;
    const newZ = fpPosition.z + moveZ;
    if (!checkCollision(newX, fpPosition.z, radius)) {
        fpPosition.x = newX;
    }
    if (!checkCollision(fpPosition.x, newZ, radius)) {
        fpPosition.z = newZ;
    }
    const isMoving = fpMoveForward || fpMoveBackward || fpMoveLeft || fpMoveRight;
    if (isMoving) {
        fpBobPhase += delta * (fpSprinting ? 12 : 8);
        const bobY = Math.sin(fpBobPhase) * fpBobAmount;
        const bobX = Math.cos(fpBobPhase * 0.5) * fpBobAmount * 0.5;
        fpPosition.y = fpHeight + bobY;
        camera.position.set(fpPosition.x + bobX, fpPosition.y, fpPosition.z);
    } else {
        fpPosition.y += (fpHeight - fpPosition.y) * 0.12;
        camera.position.copy(fpPosition);
    }
    updateFPCamera();
    checkProductProximity();
}

function enterFirstPerson() {
    if (!initialized || !renderer || !camera || !controls) return;
    if (fpMode) return;
    fpMode = true;
    autoWalking = false;
    controls.enabled = false;
    buildCollisionBoxes();
    if (window.currentRouteWaypoints?.length) {
        const w0 = window.currentRouteWaypoints[0];
        fpPosition.set(w0.x, fpHeight, w0.z);
    } else {
        fpPosition.set(35, fpHeight, 58);
    }
    fpYaw = -Math.PI / 2;
    fpPitch = 0;
    camera.position.copy(fpPosition);
    camera.rotation.order = 'YXZ';
    updateFPCamera();
    loopPrevTime = performance.now();
    document.addEventListener('keydown', fpKeyDown);
    document.addEventListener('keyup', fpKeyUp);
    const el = renderer.domElement;
    el.addEventListener('mousedown', fpMouseDownHandler);
    el.addEventListener('mouseup', fpMouseUpHandler);
    el.addEventListener('mouseleave', fpMouseUpHandler);
    el.addEventListener('mousemove', fpMouseMoveHandler);
    el.addEventListener('wheel', fpWheelHandler, { passive: false });
    el.addEventListener('touchstart', fpTouchStart, { passive: false });
    el.addEventListener('touchmove', fpTouchMove, { passive: false });
    el.addEventListener('touchend', fpTouchEnd);
    showFPHud();
    maybeAddFpWalkButton();
    const overviewControls = document.getElementById('sm-controls');
    if (overviewControls) overviewControls.style.display = 'none';
    document.getElementById('sm-mode-overview')?.classList.remove('sm-mode-active');
    document.getElementById('sm-mode-firstperson')?.classList.add('sm-mode-active');
}

function exitFirstPerson() {
    if (!fpMode) return;
    fpMode = false;
    autoWalking = false;
    document.removeEventListener('keydown', fpKeyDown);
    document.removeEventListener('keyup', fpKeyUp);
    if (renderer) {
        const el = renderer.domElement;
        el.removeEventListener('mousedown', fpMouseDownHandler);
        el.removeEventListener('mouseup', fpMouseUpHandler);
        el.removeEventListener('mouseleave', fpMouseUpHandler);
        el.removeEventListener('mousemove', fpMouseMoveHandler);
        el.removeEventListener('wheel', fpWheelHandler, { passive: false });
        el.removeEventListener('touchstart', fpTouchStart, { passive: false });
        el.removeEventListener('touchmove', fpTouchMove, { passive: false });
        el.removeEventListener('touchend', fpTouchEnd);
    }
    fpLookDragging = false;
    fpMoveForward = fpMoveBackward = fpMoveLeft = fpMoveRight = false;
    fpSprinting = false;
    fpTouchId = null;
    fpMoveTouchId = null;
    if (controls) {
        controls.enabled = true;
        camera.position.set(40, 55, 80);
        camera.rotation.order = 'XYZ';
        controls.target.set(40, 0, 30);
        controls.update();
        camera.lookAt(40, 0, 30);
    }
    hideFPHud();
    const overviewControls = document.getElementById('sm-controls');
    if (overviewControls) overviewControls.style.display = '';
    document.getElementById('sm-mode-overview')?.classList.add('sm-mode-active');
    document.getElementById('sm-mode-firstperson')?.classList.remove('sm-mode-active');
    maybeAddFpWalkButton();
}

// ============ BUILD STORE ============
function buildStoreGeometry() {
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xd6d3cc });
    const wallH = 3.5;

    addBox(80, wallH, 0.3, 40, wallH / 2, 0, wallMat);
    addBox(0.3, wallH, 60, 0, wallH / 2, 30, wallMat);
    addBox(0.3, wallH, 60, 80, wallH / 2, 30, wallMat);
    addBox(15, wallH, 0.3, 10, wallH / 2, 60, wallMat);
    addBox(25, wallH, 0.3, 67, wallH / 2, 60, wallMat);

    const zones = [
        { name: 'Cake/Meal', color: 0xf59e0b, x: 5, z: 4, w: 10, d: 8 },
        { name: 'Bakery', color: 0xfbbf24, x: 17.5, z: 5, w: 15, d: 10 },
        { name: 'Dairy', color: 0x3b82f6, x: 32.5, z: 3, w: 15, d: 6 },
        { name: 'Dairy', color: 0x3b82f6, x: 47.5, z: 3, w: 15, d: 6 },
        { name: 'Deli/Prepared', color: 0xf97316, x: 69, z: 6, w: 22, d: 12 },
        { name: 'Case Meat', color: 0xef4444, x: 4, z: 11, w: 8, d: 6 },
        { name: 'Butchers', color: 0xdc2626, x: 5, z: 18, w: 10, d: 8 },
        { name: 'Fishermans', color: 0x0ea5e9, x: 5, z: 26, w: 10, d: 8 },
        { name: 'Produce', color: 0x22c55e, x: 8, z: 40, w: 16, d: 16 },
        { name: 'Frozen', color: 0xa78bfa, x: 69, z: 26, w: 8, d: 28 },
        { name: 'Deli Counter', color: 0xfb923c, x: 18, z: 19, w: 12, d: 10 },
        { name: 'Checkout', color: 0x9ca3af, x: 38, z: 48, w: 20, d: 8 },
        { name: 'Floral', color: 0xf472b6, x: 35, z: 55, w: 14, d: 6 },
        { name: 'Health/Beauty', color: 0xc084fc, x: 63, z: 47, w: 16, d: 10 },
        { name: 'Customer Svc', color: 0x6b7280, x: 61, z: 55, w: 12, d: 6 },
    ];

    zones.forEach((z) => {
        const pg = new THREE.PlaneGeometry(z.w, z.d);
        const pm = new THREE.MeshStandardMaterial({
            color: z.color,
            transparent: true,
            opacity: 0.25,
            roughness: 1,
        });
        const plane = new THREE.Mesh(pg, pm);
        plane.rotation.x = -Math.PI / 2;
        plane.position.set(z.x, 0.02, z.z);
        scene.add(plane);

        const counterH = 1.2;
        const cm = new THREE.MeshStandardMaterial({ color: z.color, transparent: true, opacity: 0.55 });
        addBox(z.w * 0.8, counterH, 1, z.x, counterH / 2, z.z - z.d / 2 + 0.5, cm);

        addLabel(z.name, z.x, 4.5, z.z);
    });

    const shelfMat = new THREE.MeshStandardMaterial({ color: 0x8b7355 });
    const aisleNames = ['Canned Goods', 'Cereals', 'Baking', 'Pasta & Grains', 'Snacks', 'Beverages'];
    for (let i = 0; i < 6; i++) {
        const z = 12 + i * 5;
        addBox(38, 2.5, 0.5, 37, 1.25, z - 0.75, shelfMat);
        addBox(38, 2.5, 0.5, 37, 1.25, z + 0.75, shelfMat);
        addLabel(`Aisle ${i + 1}: ${aisleNames[i]}`, 37, 3.5, z);
    }

    const regMat = new THREE.MeshStandardMaterial({ color: 0x78716c });
    for (let i = 0; i < 5; i++) {
        addBox(3, 1, 0.8, 32 + i * 3.5, 0.5, 48, regMat);
    }

    const entrMat = new THREE.MeshStandardMaterial({
        color: 0x22c55e,
        emissive: 0x22c55e,
        emissiveIntensity: 0.3,
    });
    addBox(6, 0.1, 3, 37, 0.05, 59, entrMat);
    addLabel('ENTRANCE', 37, 2, 59);
}

function addBox(w, h, d, x, y, z, mat) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
}

function addLabel(text, x, y, z) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 256;
    canvas.height = 64;
    ctx.fillStyle = 'rgba(19,42,19,0.75)';
    if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(0, 0, 256, 64, 8);
        ctx.fill();
    } else {
        ctx.fillRect(0, 0, 256, 64);
    }
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 32);

    const tex = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.position.set(x, y, z);
    sprite.scale.set(8, 2, 1);
    scene.add(sprite);
    labelSprites.push(sprite);
}

function buildProducts(data) {
    productMeshes.forEach((m) => {
        scene.remove(m);
        m.geometry?.dispose();
        m.material?.dispose();
    });
    productMeshes = [];
    if (!data?.zones) return;

    data.zones.forEach((zone) => {
        if (!zone.products) return;
        zone.products.forEach((prod) => {
            const rec = prod.is_recommended;
            const color = rec ? 0x22c55e : prod.kg_co2e > 8 ? 0xef4444 : 0xeab308;
            const mat = new THREE.MeshStandardMaterial({
                color,
                emissive: rec ? 0x22c55e : 0x000000,
                emissiveIntensity: rec ? 0.3 : 0,
            });
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), mat);
            mesh.position.set(prod.shelf_x, 1.8, prod.shelf_z);
            mesh.castShadow = true;
            mesh.userData = { ...prod, zone_name: zone.name, category: zone.category || zone.name };
            scene.add(mesh);
            productMeshes.push(mesh);
        });
    });

    const ecoOn = document.getElementById('sm-eco-picks')?.checked;
    if (ecoOn) applyEcoHighlight(true);
}

function buildCategoryFilters(data) {
    const container = document.getElementById('sm-category-filters');
    if (!container) return;
    const cats = data?.zones
        ? [...new Set(data.zones.map((z) => z.category || z.name))]
        : ['Produce', 'Meat', 'Dairy', 'Frozen', 'Grains', 'Snacks', 'Household', 'Other'];
    container.innerHTML = cats
        .map((c) => {
            const safe = String(c).replace(/"/g, '&quot;');
            return `<label style="display:flex;align-items:center;gap:6px;margin:4px 0;font-size:0.88em;cursor:pointer;"><input type="checkbox" checked data-category="${safe}"> ${escapeHtml(c)}</label>`;
        })
        .join('');
}

function clearRoute() {
    if (routeLine) {
        scene.remove(routeLine);
        routeLine.geometry?.dispose();
        routeLine.material?.dispose();
        routeLine = null;
    }
    stopMarkers.forEach((m) => {
        scene.remove(m);
        if (m.geometry) m.geometry.dispose();
        if (m.material) m.material.dispose();
    });
    stopMarkers.length = 0;
    routeCurve = null;
    routeAnimT = 0;
    window.currentRouteWaypoints = [];
    document.getElementById('sm-fp-walk-route')?.remove();
}

function renderRoute(data) {
    clearRoute();
    const pts = data.waypoints.map((w) => new THREE.Vector3(w.x, 0.12, w.z));
    if (pts.length < 2) return;

    routeCurve = new THREE.CatmullRomCurve3(pts);
    const tubeGeo = new THREE.TubeGeometry(routeCurve, Math.max(32, pts.length * 4), 0.15, 8, false);
    const tubeMat = new THREE.MeshStandardMaterial({
        color: 0x2dd4bf,
        emissive: 0x0f766e,
        emissiveIntensity: 0.25,
    });
    routeLine = new THREE.Mesh(tubeGeo, tubeMat);
    scene.add(routeLine);

    if (!routeSphere) {
        routeSphere = new THREE.Mesh(
            new THREE.SphereGeometry(0.3, 16, 16),
            new THREE.MeshStandardMaterial({
                color: 0x22c55e,
                emissive: 0x22c55e,
                emissiveIntensity: 0.6,
            })
        );
        scene.add(routeSphere);
    }
    routeAnimT = 0;

    const show = document.getElementById('sm-show-route')?.checked !== false;
    routeLine.visible = show;
    routeSphere.visible = show;

    data.stops.forEach((s) => {
        const cyl = new THREE.Mesh(
            new THREE.CylinderGeometry(0.4, 0.4, 0.12, 24),
            new THREE.MeshStandardMaterial({ color: 0xfacc15 })
        );
        cyl.position.set(s.x, 0.08, s.z);
        cyl.visible = show;
        scene.add(cyl);
        stopMarkers.push(cyl);
    });

    window.currentRouteWaypoints = data.waypoints.map((w) => ({ x: w.x, z: w.z }));
    maybeAddFpWalkButton();
}

function animateCameraTo(pos, target) {
    if (fpMode || !camera || !controls) return;
    const startP = camera.position.clone();
    const startT = controls.target.clone();
    let f = 0;
    const frames = 50;
    function tick() {
        f++;
        const t = f / frames;
        const e = 1 - (1 - t) * (1 - t);
        camera.position.lerpVectors(startP, pos, e);
        controls.target.lerpVectors(startT, target, e);
        controls.update();
        if (f < frames) requestAnimationFrame(tick);
    }
    tick();
}

// ============ LOOP ============
function startLoop() {
    if (animFrameId != null) return;
    loopPrevTime = performance.now();
    function tick() {
        animFrameId = requestAnimationFrame(tick);
        const time = performance.now();
        const delta = Math.min((time - loopPrevTime) / 1000, 0.1);
        loopPrevTime = time;
        if (fpMode) {
            if (autoWalking) {
                updateAutoWalk(delta);
            } else {
                updateFirstPerson(delta);
            }
            updateMinimap();
        } else {
            if (routeSphere && routeCurve) {
                routeAnimT += 0.008;
                const u = routeAnimT % 1;
                routeSphere.position.copy(routeCurve.getPoint(u));
            }
            if (controls) controls.update();
        }
        if (renderer && scene && camera) renderer.render(scene, camera);
    }
    animFrameId = requestAnimationFrame(tick);
}

function stopLoop() {
    if (fpMode) exitFirstPerson();
    if (animFrameId != null) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
    }
}

function onResize() {
    const c = getContainer();
    if (!c || !camera || !renderer) return;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
}

function resetView() {
    if (fpMode) exitFirstPerson();
    if (!camera || !controls) return;
    camera.position.set(40, 55, 80);
    controls.target.set(40, 0, 30);
    controls.update();
    camera.lookAt(40, 0, 30);
}

window.initSupermarket = init;
window.stopSupermarketRender = stopLoop;
window.resetSupermarketView = resetView;
window.enterFirstPerson = enterFirstPerson;
window.exitFirstPerson = exitFirstPerson;
