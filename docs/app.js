/* Singapore electoral boundaries + MP directory.
   Data is pre-joined at build time (see scripts/build_site_data.py), so this
   file only has to draw it and wire up the interactions. */
(function () {
  "use strict";

  var PARTY = {
    "People's Action Party": { key: "pap", short: "PAP", color: "#2563eb" },
    "Workers' Party": { key: "wp", short: "WP", color: "#f59e0b" }
  };
  var DEFAULT_PARTY = { key: "other", short: "", color: "#10b981" };
  var SG_BOUNDS = L.latLngBounds([1.197, 103.59], [1.48, 104.1]);

  var state = {
    geo: null,
    mps: null,
    layers: {},        // division id -> Leaflet layer
    activeId: null,
    lastFocus: null
  };

  var el = {
    map: document.getElementById("map"),
    hint: document.getElementById("map-hint"),
    list: document.getElementById("division-list"),
    search: document.getElementById("search"),
    suggestions: document.getElementById("suggestions"),
    backdrop: document.getElementById("modal-backdrop"),
    modal: document.getElementById("modal"),
    eyebrow: document.getElementById("modal-eyebrow"),
    title: document.getElementById("modal-title"),
    sub: document.getElementById("modal-sub"),
    body: document.getElementById("modal-body"),
    footNote: document.getElementById("modal-foot-note"),
    close: document.getElementById("modal-close"),
    locate: document.getElementById("locate"),
    generated: document.getElementById("generated")
  };

  // ------------------------------------------------------------- utilities

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function partyOf(name) {
    // Parliament's pages mix straight and curly apostrophes in party names.
    return PARTY[String(name || "").replace(/’/g, "'")] || DEFAULT_PARTY;
  }

  /** Dominant party of a division, used to colour its polygon. */
  function divisionParty(props) {
    var parties = props.parties || [];
    return partyOf(parties.length === 1 ? parties[0] : parties[0]);
  }

  /** "62456501" -> "6245 6501"; leaves anything unexpected alone. */
  function prettyPhone(digits) {
    return /^\d{8}$/.test(digits) ? digits.slice(0, 4) + " " + digits.slice(4) : digits;
  }

  function waLink(digits) {
    if (!/^\d{8}$/.test(digits)) return null;
    return "https://wa.me/65" + digits;
  }

  // ------------------------------------------------------------------- map

  var map = L.map(el.map, {
    zoomControl: true,
    attributionControl: true,
    maxBounds: SG_BOUNDS.pad(0.6),
    minZoom: 11
  });

  // OneMap is the Singapore Land Authority's own basemap: no API key needed and
  // its grey style keeps the constituency fills legible. It only serves the
  // Singapore extent, so `bounds` stops Leaflet requesting tiles it will 404 on.
  L.tileLayer("https://www.onemap.gov.sg/maps/tiles/Grey/{z}/{x}/{y}.png", {
    attribution: 'New OneMap | Map data &copy; contributors, <a href="https://www.sla.gov.sg/" target="_blank" rel="noopener">Singapore Land Authority</a>',
    bounds: SG_BOUNDS,
    minZoom: 11,
    maxZoom: 19
  }).addTo(map);

  map.attributionControl.addAttribution(
    'Boundaries &copy; <a href="https://www.eld.gov.sg/" target="_blank" rel="noopener">ELD</a> via <a href="https://data.gov.sg/" target="_blank" rel="noopener">data.gov.sg</a>');

  function baseStyle(feature) {
    return {
      color: "#ffffff",
      weight: 1.6,
      opacity: 0.95,
      fillColor: divisionParty(feature.properties).color,
      fillOpacity: feature.properties.type === "GRC" ? 0.46 : 0.62
    };
  }

  function highlightStyle(feature) {
    var s = baseStyle(feature);
    s.weight = 3;
    s.color = "#0f172a";
    s.fillOpacity = 0.78;
    return s;
  }

  function setActive(id) {
    if (state.activeId && state.layers[state.activeId]) {
      var prev = state.layers[state.activeId];
      prev.setStyle(baseStyle(prev.feature));
    }
    state.activeId = id;
    if (id && state.layers[id]) {
      var cur = state.layers[id];
      cur.setStyle(highlightStyle(cur.feature));
      cur.bringToFront();
    }
    Array.prototype.forEach.call(el.list.querySelectorAll("button"), function (b) {
      b.classList.toggle("is-active", b.dataset.id === id);
    });
  }

  function dismissHint() {
    if (el.hint && !el.hint.classList.contains("hidden")) {
      el.hint.classList.add("hidden");
      setTimeout(function () { el.hint.remove(); }, 500);
    }
  }

  function renderMap(geo) {
    var layers = L.geoJSON(geo, {
      style: baseStyle,
      onEachFeature: function (feature, layer) {
        var p = feature.properties;
        state.layers[p.id] = layer;

        layer.bindTooltip(
          '<span>' + esc(p.name) + '</span><small>' + p.seats +
          (p.seats === 1 ? " MP" : " MPs") + " &middot; tap for details</small>",
          { className: "div-tip", sticky: true, direction: "top", opacity: 1 }
        );

        layer.on({
          mouseover: function () { if (p.id !== state.activeId) layer.setStyle(highlightStyle(feature)); },
          mouseout: function () { if (p.id !== state.activeId) layer.setStyle(baseStyle(feature)); },
          click: function () { dismissHint(); openDivision(p.id, { zoom: false }); }
        });
      }
    }).addTo(map);

    map.fitBounds(layers.getBounds(), { padding: [16, 16] });
  }

  function renderSidebar(geo) {
    var sorted = geo.features.slice().sort(function (a, b) {
      return a.properties.name.localeCompare(b.properties.name);
    });
    var frag = document.createDocumentFragment();
    sorted.forEach(function (f) {
      var p = f.properties;
      var li = document.createElement("li");
      li.innerHTML =
        '<button type="button" data-id="' + esc(p.id) + '">' +
        '<span class="d-dot" style="background:' + divisionParty(p).color + '"></span>' +
        '<span class="d-name">' + esc(p.name) + '</span>' +
        '<span class="d-seats">' + p.seats + (p.seats === 1 ? " MP" : " MPs") + "</span>" +
        "</button>";
      frag.appendChild(li);
    });
    el.list.appendChild(frag);
    el.list.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-id]");
      if (btn) { dismissHint(); openDivision(btn.dataset.id, { zoom: true }); }
    });
  }

  // ----------------------------------------------------------- MP rendering

  function roleItems(mp) {
    var roles = (mp.currentRoles || []).filter(Boolean);
    // Backbenchers have no office-holding appointment; say so rather than
    // leaving the section empty.
    if (!roles.length || (roles.length === 1 && /^member of parliament$/i.test(roles[0]))) {
      return '<li class="backbench">Backbencher &mdash; no office-holding appointment</li>';
    }
    return roles.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("");
  }

  function contactRows(mp) {
    var rows = [];

    if (mp.email) {
      rows.push('<a href="mailto:' + esc(mp.email) + '"><span class="ic mail">✉</span>' +
        esc(mp.email) + "</a>");
    }
    if (mp.officialEmail && mp.officialEmail !== mp.email) {
      rows.push('<a href="mailto:' + esc(mp.officialEmail) + '"><span class="ic mail">✉</span>' +
        esc(mp.officialEmail) + " <span class=\"hint\">(ministry)</span></a>");
    }

    // MPs do not publish personal WhatsApp numbers. The number shown is the
    // office line listed in the Government Directory, offered as a WhatsApp
    // link because many constituency offices do accept messages on it.
    var wa = waLink(mp.phone);
    if (wa) {
      rows.push('<a href="' + esc(wa) + '" target="_blank" rel="noopener">' +
        '<span class="ic wa">💬</span><span class="stack">' +
        "<span>WhatsApp " + esc(prettyPhone(mp.phone)) + "</span>" +
        '<span class="hint">Publicly listed office line &mdash; not a personal number</span>' +
        "</span></a>");
      rows.push('<a href="tel:+65' + esc(mp.phone) + '"><span class="ic">☎</span>Call ' +
        esc(prettyPhone(mp.phone)) + "</a>");
    } else {
      rows.push('<span class="none"><span class="ic">💬</span>No phone or WhatsApp number publicly listed</span>');
    }

    return rows.join("");
  }

  function sessionBlocks(mp) {
    if (!mp.mps || !mp.mps.length) return "";
    return '<div class="mp-section"><h4>Meet-the-People Session</h4>' +
      mp.mps.map(function (s) {
        var bits = [];
        if (s.place) bits.push("<span><b>Where:</b> " + esc(s.place) + "</span>");
        if (s.time) bits.push("<span><b>When:</b> " + esc(s.time) + "</span>");
        return '<div class="mps-session">' + bits.join("") + "</div>";
      }).join("") + "</div>";
  }

  var SOCIAL_LABEL = {
    facebook: "Facebook", twitter: "X / Twitter", instagram: "Instagram",
    linkedin: "LinkedIn", youtube: "YouTube", tiktok: "TikTok",
    website: "Website", phone: "Govt directory", cv: "CV (PDF)"
  };

  function socialLinks(mp) {
    var links = mp.links || {};
    var items = Object.keys(links).map(function (k) {
      return '<a href="' + esc(links[k]) + '" target="_blank" rel="noopener">' +
        esc(SOCIAL_LABEL[k] || k) + "</a>";
    });
    items.push('<a href="' + esc(mp.detailUrl) + '" target="_blank" rel="noopener">Parliament profile</a>');
    return '<div class="socials">' + items.join("") + "</div>";
  }

  function pastRoles(mp) {
    var past = mp.pastRoles || [];
    if (!past.length) return "";
    return '<details class="past"><summary>' + past.length +
      " previous appointment" + (past.length === 1 ? "" : "s") + "</summary><ol>" +
      past.map(function (a) {
        return "<li>" + esc(a.title) + "<time>" + esc(a.period) + "</time></li>";
      }).join("") + "</ol></details>";
  }

  function mpCard(mp, opts) {
    var party = partyOf(mp.party);
    // Nominated MPs are non-partisan and carry no party on their profile.
    var chips = mp.party
      ? ['<span class="chip party" data-party="' + party.key + '">' +
         esc(party.short || mp.party) + "</span>"]
      : ['<span class="chip">Non-partisan</span>'];
    if (opts && opts.showConstituency) chips.push('<span class="chip">' + esc(mp.constituency) + "</span>");
    if (mp.termsServed) {
      chips.push('<span class="chip">' + mp.termsServed + " term" +
        (mp.termsServed === 1 ? "" : "s") + (mp.mpSince ? " &middot; MP since " +
        esc(mp.mpSince.replace(/^\d+ \w+ /, "")) : "") + "</span>");
    }
    if (mp.yearOfBirth) chips.push('<span class="chip">b. ' + esc(mp.yearOfBirth) + "</span>");

    return '<article class="mp-card">' +
      '<img class="mp-photo" src="' + esc(mp.photoLocal || "") + '" alt="Photograph of ' +
        esc(mp.name) + '" loading="lazy" width="112" height="149">' +
      '<div class="mp-main">' +
        '<h3 class="mp-name"><span class="sal">' + esc(mp.salutation || "") + "</span> " +
          esc(mp.name) + "</h3>" +
        '<div class="chips">' + chips.join("") + "</div>" +
        '<div class="mp-section"><h4>Roles in office</h4><ul class="roles">' +
          roleItems(mp) + "</ul>" + pastRoles(mp) + "</div>" +
        '<div class="mp-section"><h4>Contact</h4><div class="contact">' +
          contactRows(mp) + "</div></div>" +
        sessionBlocks(mp) +
        socialLinks(mp) +
      "</div></article>";
  }

  // ----------------------------------------------------------------- modal

  function showModal(opts) {
    state.lastFocus = document.activeElement;
    el.eyebrow.textContent = opts.eyebrow || "";
    el.title.innerHTML = esc(opts.title);
    el.sub.innerHTML = opts.sub || "";
    el.body.innerHTML = opts.body;
    el.footNote.innerHTML = opts.foot || "";
    el.backdrop.hidden = false;
    el.body.scrollTop = 0;
    document.body.style.overflow = "hidden";
    el.modal.focus();
  }

  function closeModal() {
    el.backdrop.hidden = true;
    document.body.style.overflow = "";
    if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
  }

  function openDivision(id, opts) {
    var layer = state.layers[id];
    if (!layer) return;
    var p = layer.feature.properties;
    var members = (state.mps.byDivision[id] || []);

    setActive(id);
    if (opts && opts.zoom) map.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 15 });

    var partyCount = members.reduce(function (acc, m) {
      var k = partyOf(m.party).short || m.party;
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    var partyText = Object.keys(partyCount).map(function (k) {
      return k + " × " + partyCount[k];
    }).join(" &middot; ");

    showModal({
      eyebrow: p.type === "GRC" ? "Group Representation Constituency" : "Single Member Constituency",
      title: p.name,
      sub: members.length + (members.length === 1 ? " Member" : " Members") +
        " of Parliament &middot; " + partyText,
      body: members.length
        ? members.map(function (m) { return mpCard(m, {}); }).join("")
        : "<p>No MP records matched this division.</p>",
      foot: "Office-holding roles, photographs and Meet-the-People details from parliament.gov.sg; " +
        "emails and phone numbers from the Singapore Government Directory."
    });
  }

  function openUnelected() {
    var groups = state.mps.unelected || {};
    var body = Object.keys(groups).filter(function (k) { return groups[k].length; }).map(function (k) {
      var heading = k.replace("Member of Parliament", "Members of Parliament");
      return '<div class="mp-section"><h4>' + esc(heading) + " (" + groups[k].length + ")</h4></div>" +
        groups[k].map(function (m) { return mpCard(m, { showConstituency: false }); }).join("");
    }).join("");

    setActive(null);
    showModal({
      eyebrow: "Members without an electoral division",
      title: "NMPs & NCMPs",
      sub: "Nominated MPs are appointed by the President; Non-Constituency MPs are the best-performing losing opposition candidates.",
      body: body,
      foot: "These members sit in Parliament but do not represent a geographic constituency."
    });
  }

  function openMp(slug) {
    var all = allMps();
    var mp = all.filter(function (m) { return m.slug === slug; })[0];
    if (!mp) return;
    var divisionId = String(mp.constituency).toUpperCase().replace(/\s+(GRC|SMC)$/, "");
    if (state.layers[divisionId]) {
      openDivision(divisionId, { zoom: true });
      // Scroll the chosen MP's card into view within the division modal.
      var cards = el.body.querySelectorAll(".mp-card");
      var members = state.mps.byDivision[divisionId] || [];
      for (var i = 0; i < members.length; i++) {
        if (members[i].slug === slug && cards[i]) {
          cards[i].scrollIntoView({ block: "start", behavior: "smooth" });
          break;
        }
      }
    } else {
      openUnelected();
    }
  }

  // ---------------------------------------------------------------- search

  function allMps() {
    var out = [];
    var add = function (arr) { Array.prototype.push.apply(out, arr); };
    Object.keys(state.mps.byDivision).forEach(function (k) { add(state.mps.byDivision[k]); });
    Object.keys(state.mps.unelected).forEach(function (k) { add(state.mps.unelected[k]); });
    return out;
  }

  var searchIndex = [];
  var activeSuggestion = -1;

  function buildSearchIndex() {
    searchIndex = state.geo.features.map(function (f) {
      return {
        kind: "division",
        id: f.properties.id,
        label: f.properties.name,
        meta: f.properties.seats + (f.properties.seats === 1 ? " MP" : " MPs"),
        color: divisionParty(f.properties).color,
        hay: f.properties.name.toLowerCase()
      };
    }).concat(allMps().map(function (m) {
      return {
        kind: "mp",
        id: m.slug,
        label: m.name,
        meta: m.constituency,
        photo: m.photoLocal,
        hay: (m.name + " " + m.constituency + " " + (m.currentRoles || []).join(" ")).toLowerCase()
      };
    }));
  }

  function runSearch(q) {
    q = q.trim().toLowerCase();
    if (q.length < 2) return [];
    var starts = [], contains = [];
    searchIndex.forEach(function (item) {
      var i = item.hay.indexOf(q);
      if (i === 0 || item.label.toLowerCase().indexOf(q) === 0) starts.push(item);
      else if (i > -1) contains.push(item);
    });
    return starts.concat(contains).slice(0, 10);
  }

  function renderSuggestions(items) {
    activeSuggestion = -1;
    if (!items.length) {
      el.suggestions.hidden = true;
      el.search.setAttribute("aria-expanded", "false");
      return;
    }
    el.suggestions.innerHTML = items.map(function (it, i) {
      var lead = it.kind === "division"
        ? '<span class="s-dot" style="background:' + it.color + '"></span>'
        : '<img src="' + esc(it.photo || "") + '" alt="">';
      return '<li role="option" data-kind="' + it.kind + '" data-id="' + esc(it.id) + '" data-i="' + i + '">' +
        lead + "<span>" + esc(it.label) + '</span><span class="s-meta">' + esc(it.meta) + "</span></li>";
    }).join("");
    el.suggestions.hidden = false;
    el.search.setAttribute("aria-expanded", "true");
  }

  function chooseSuggestion(li) {
    if (!li) return;
    dismissHint();
    el.suggestions.hidden = true;
    el.search.setAttribute("aria-expanded", "false");
    el.search.value = "";
    if (li.dataset.kind === "division") openDivision(li.dataset.id, { zoom: true });
    else openMp(li.dataset.id);
  }

  function wireSearch() {
    el.search.addEventListener("input", function () {
      renderSuggestions(runSearch(el.search.value));
    });

    el.search.addEventListener("keydown", function (e) {
      var items = el.suggestions.querySelectorAll("li");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!items.length) return;
        e.preventDefault();
        activeSuggestion += e.key === "ArrowDown" ? 1 : -1;
        if (activeSuggestion < 0) activeSuggestion = items.length - 1;
        if (activeSuggestion >= items.length) activeSuggestion = 0;
        Array.prototype.forEach.call(items, function (li, i) {
          li.setAttribute("aria-selected", i === activeSuggestion ? "true" : "false");
        });
        items[activeSuggestion].scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        e.preventDefault();
        chooseSuggestion(items[activeSuggestion >= 0 ? activeSuggestion : 0]);
      } else if (e.key === "Escape") {
        el.suggestions.hidden = true;
        el.search.value = "";
      }
    });

    el.suggestions.addEventListener("mousedown", function (e) {
      e.preventDefault();  // keep focus so blur doesn't close before the click lands
      chooseSuggestion(e.target.closest("li"));
    });

    el.search.addEventListener("blur", function () {
      setTimeout(function () { el.suggestions.hidden = true; }, 120);
    });
  }

  // -------------------------------------------------------------- geolocate

  /** Ray-casting point-in-polygon over a GeoJSON ring (lon/lat pairs). */
  function inRing(lon, lat, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  function inPolygon(lon, lat, rings) {
    if (!inRing(lon, lat, rings[0])) return false;
    for (var h = 1; h < rings.length; h++) {
      if (inRing(lon, lat, rings[h])) return false;  // inside a hole
    }
    return true;
  }

  function findDivision(lon, lat) {
    var feats = state.geo.features;
    for (var i = 0; i < feats.length; i++) {
      var g = feats[i].geometry;
      var polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      for (var p = 0; p < polys.length; p++) {
        if (inPolygon(lon, lat, polys[p])) return feats[i].properties.id;
      }
    }
    return null;
  }

  function wireLocate() {
    el.locate.addEventListener("click", function () {
      if (!navigator.geolocation) {
        alert("Your browser does not support location lookup.");
        return;
      }
      el.locate.setAttribute("aria-busy", "true");
      navigator.geolocation.getCurrentPosition(function (pos) {
        el.locate.removeAttribute("aria-busy");
        var lat = pos.coords.latitude, lon = pos.coords.longitude;
        var id = findDivision(lon, lat);
        dismissHint();
        if (id) {
          L.circleMarker([lat, lon], {
            radius: 7, color: "#fff", weight: 2, fillColor: "#ef4444", fillOpacity: 1
          }).addTo(map).bindTooltip("You are here", { className: "div-tip" });
          openDivision(id, { zoom: true });
        } else {
          alert("You do not appear to be inside a Singapore electoral division.");
        }
      }, function () {
        el.locate.removeAttribute("aria-busy");
        alert("Could not get your location. Check that location access is allowed for this site.");
      }, { enableHighAccuracy: true, timeout: 10000 });
    });
  }

  // ------------------------------------------------------------------ init

  function wireModal() {
    el.close.addEventListener("click", closeModal);
    el.backdrop.addEventListener("click", function (e) {
      if (e.target === el.backdrop) closeModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !el.backdrop.hidden) closeModal();
    });
    document.getElementById("show-unelected").addEventListener("click", openUnelected);
    document.getElementById("sidebar-unelected").addEventListener("click", openUnelected);
  }

  Promise.all([
    fetch("data/divisions.geojson").then(function (r) { return r.json(); }),
    fetch("data/mps.json").then(function (r) { return r.json(); })
  ]).then(function (res) {
    state.geo = res[0];
    state.mps = res[1];

    renderMap(state.geo);
    renderSidebar(state.geo);
    buildSearchIndex();
    wireSearch();
    wireLocate();
    wireModal();

    if (state.mps.generated) el.generated.textContent = state.mps.generated;
    setTimeout(dismissHint, 9000);
  }).catch(function (err) {
    el.map.innerHTML = '<div style="padding:40px;font-family:sans-serif">' +
      "<h2>Could not load the map data</h2><p>" + esc(err.message) + "</p></div>";
  });
})();
