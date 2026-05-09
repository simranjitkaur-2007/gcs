function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatHMS(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function crc16Modbus(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i);
    for (let j = 0; j < 8; j++) {
      const lsb = crc & 1;
      crc >>= 1;
      if (lsb) crc ^= 0xa001;
    }
  }
  return crc & 0xffff;
}

function bytesUtf8(str) {
  return new TextEncoder().encode(str).length;
}

function downloadText(filename, content) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function setText(id, value) {
  $(id).textContent = value;
}

function setHeaderStatus(connected) {
  const pill = $("conn-pill");
  const btn = $("btn-connect");

  pill.textContent = connected ? "CONNECTED" : "DISCONNECTED";
  pill.dataset.state = connected ? "on" : "off";
  btn.textContent = connected ? "Disconnect" : "Connect";
  btn.dataset.state = connected ? "on" : "off";
}

function setNoDataMode() {
  const noData = "No Data";
  setText("val-pkt", noData);
  setText("val-state", noData);
  setText("val-alt2", noData);
  setText("val-pres2", noData);
  setText("val-temp2", noData);
  setText("val-volt", noData);
  setText("val-gnss-time", noData);
  setText("val-lat", noData);
  setText("val-lon", noData);
  setText("val-gnss-alt", noData);
  setText("val-sats", noData);
  setText("val-acc", noData);
  setText("val-gyro", noData);

  setText("val-crc", "0x----");
  setText("val-rate", "0 Hz");
  setText("val-datarate", "0 B/s");
  $("raw-stream").textContent = "AWAITING PACKET...";
}

function pushConsole(line) {
  const con = $("packet-console");
  con.innerHTML = `${line}<br>${con.innerHTML}`;
  if (con.innerHTML.length > 900) con.innerHTML = con.innerHTML.substring(0, 900);
}

function createCharts() {
  const theme = getComputedStyle(document.documentElement);
  const cCyan = theme.getPropertyValue("--cyan").trim();
  const cAmber = theme.getPropertyValue("--amber").trim();
  const cMagenta = theme.getPropertyValue("--magenta").trim();

  const ctxOptions = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      y: { grid: { color: "#222" }, ticks: { color: "#888", font: { family: "Iceland" } } },
      x: { display: false },
    },
    plugins: { legend: { labels: { color: "#fff", font: { family: "Iceland" } } } },
  };

  const altChart = new Chart($("altChart"), {
    type: "line",
    data: { labels: Array(20).fill(""), datasets: [{ label: "Altitude (m)", data: Array(20).fill(0), borderColor: cCyan, tension: 0.3, pointRadius: 0 }] },
    options: ctxOptions,
  });

  const gyroChart = new Chart($("gyroChart"), {
    type: "line",
    data: { labels: Array(20).fill(""), datasets: [{ label: "Gyro X/Y/Z", data: Array(20).fill(0), borderColor: cAmber, tension: 0.3, pointRadius: 0 }] },
    options: ctxOptions,
  });

  const accChart = new Chart($("accChart"), {
    type: "line",
    data: { labels: Array(20).fill(""), datasets: [{ label: "Acceleration X/Y/Z", data: Array(20).fill(0), borderColor: cMagenta, tension: 0.3, pointRadius: 0 }] },
    options: ctxOptions,
  });

  return { altChart, gyroChart, accChart };
}

function initMap() {
  const map = L.map("map").setView([26.8467, 80.9462], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);
  requestAnimationFrame(() => map.invalidateSize());

  const marker = L.circleMarker([26.8467, 80.9462], {
    radius: 6,
    color: "#7fd9e3",
    weight: 2,
    fillColor: "#7fd9e3",
    fillOpacity: 0.65,
  }).addTo(map);

  return { map, marker };
}

function csvHeaders() {
  return [
    "TEAM_ID",
    "TIME_STAMPING_S",
    "PACKET_COUNT",
    "ALTITUDE_M",
    "PRESSURE_PA",
    "TEMP_C",
    "VOLTAGE_V",
    "GNSS_TIME_S",
    "GNSS_LAT_DEG",
    "GNSS_LON_DEG",
    "GNSS_ALT_M",
    "GNSS_SATS",
    "ACCEL_MPS2",
    "GYRO_DEGPS",
    "FLIGHT_SOFTWARE_STATE",
    "OPTIONAL",
    "CRC16_MODBUS_HEX",
  ].join(",");
}

function main() {
  const teamId = $("team-id-input").value.trim() || "2026-IN-SPACe-CAN-7USAT-XXX";
  $("team-id-input").value = teamId;
  setText("team-id-header", `VAJRA ROCKETRY - TEAM ID ${teamId}`);

  const { altChart, gyroChart, accChart } = createCharts();
  const { map, marker } = initMap();

  const flightStates = ["BOOT", "TEST_MODE", "LAUNCH_PAD", "ASCENT", "ROCKET_DEPLOY", "DESCENT", "AEROBREAK_RELEASE", "IMPACT"];
  const missionStartMs = Date.now();

  let connected = false;
  let packetCount = 0;
  let lastTickMs = Date.now();
  let lastSecondPackets = 0;
  let bytesThisSecond = 0;
  let csvLines = [csvHeaders()];

  setHeaderStatus(false);
  setNoDataMode();

  $("btn-connect").addEventListener("click", () => {
    connected = !connected;
    setHeaderStatus(connected);
    pushConsole(`[SYSTEM] ${connected ? "Connected" : "Disconnected"} - ${connected ? "telemetry running" : "telemetry paused"}`);
    if (!connected) setNoDataMode();
  });

  $("btn-save").addEventListener("click", () => {
    const filename = `Flight_${teamId}.csv`;
    downloadText(filename, csvLines.join("\n") + "\n");
    pushConsole(`[SYSTEM] Saved telemetry to ${filename}`);
  });

  setInterval(() => {
    const now = Date.now();
    const elapsedSec = Math.floor((now - missionStartMs) / 1000);
    setText("mission-clock", formatHMS(elapsedSec));

    if (!connected) return;

    packetCount += 1;

    const altM = 500 + Math.random() * 100;
    const pressurePa = 101325 + (Math.random() * 250 - 125);
    const tempC = 24 + (Math.random() * 2 - 1);
    const vel = 120 + Math.random() * 10;
    const volts = 7.4 + (Math.random() * 0.2 - 0.1);
    const lat = 26.8467 + (Math.random() * 0.005 - 0.0025);
    const lon = 80.9462 + (Math.random() * 0.005 - 0.0025);
    const gnssAlt = altM + (Math.random() * 10 - 5);
    const sats = 9 + Math.floor(Math.random() * 4);
    const acc = [(Math.random() * 2 - 1) * 9.81, (Math.random() * 2 - 1) * 9.81, (Math.random() * 2 - 1) * 9.81];
    const gyro = [(Math.random() * 2 - 1) * 120, (Math.random() * 2 - 1) * 120, (Math.random() * 2 - 1) * 120];
    const state = flightStates[Math.min(flightStates.length - 1, Math.floor(elapsedSec / 10))];

    setText("val-alt", altM.toFixed(0));
    setText("val-pres", (pressurePa / 1000).toFixed(1));
    setText("val-temp", tempC.toFixed(1));
    setText("val-vel", vel.toFixed(1));

    setText("val-pkt", String(packetCount));
    setText("val-state", state);
    setText("val-alt2", altM.toFixed(1));
    setText("val-pres2", Math.round(pressurePa).toString());
    setText("val-temp2", tempC.toFixed(1));
    setText("val-volt", volts.toFixed(2));
    setText("val-gnss-time", String(elapsedSec));
    setText("val-lat", lat.toFixed(4));
    setText("val-lon", lon.toFixed(4));
    setText("val-gnss-alt", gnssAlt.toFixed(1));
    setText("val-sats", String(sats));
    setText("val-acc", acc.map((v) => v.toFixed(1)).join(","));
    setText("val-gyro", gyro.map((v) => v.toFixed(1)).join(","));

    marker.setLatLng([lat, lon]);
    if (packetCount % 5 === 0) map.panTo([lat, lon], { animate: false });

    const rawCsv = [
      teamId,
      elapsedSec,
      packetCount,
      altM.toFixed(1),
      Math.round(pressurePa),
      tempC.toFixed(1),
      volts.toFixed(2),
      elapsedSec,
      lat.toFixed(4),
      lon.toFixed(4),
      gnssAlt.toFixed(1),
      sats,
      acc.map((v) => v.toFixed(2)).join("|"),
      gyro.map((v) => v.toFixed(2)).join("|"),
      state,
      "",
    ].join(",");

    const crc = crc16Modbus(rawCsv);
    const crcHex = `0x${crc.toString(16).toUpperCase().padStart(4, "0")}`;

    $("raw-stream").textContent = rawCsv;
    setText("val-crc", crcHex);

    const dtMs = now - lastTickMs;
    lastTickMs = now;
    lastSecondPackets += 1;
    bytesThisSecond += bytesUtf8(rawCsv) + 1;

    if (packetCount % 1 === 0) {
      [altChart, gyroChart, accChart].forEach((chart) => {
        chart.data.datasets[0].data.shift();
        chart.data.datasets[0].data.push(Math.random() * 100);
        chart.update("none");
      });
    }

    pushConsole(`> PKT_RECV: COUNT=${packetCount} STATE=${state} CRC=${crcHex}`);

    if (dtMs >= 900) {
      const hz = lastSecondPackets / (dtMs / 1000);
      setText("val-rate", `${hz.toFixed(1)} Hz`);
      setText("val-datarate", `${Math.round(bytesThisSecond / (dtMs / 1000))} B/s`);
      lastSecondPackets = 0;
      bytesThisSecond = 0;
    }

    const lineWithCrc = `${rawCsv},${crcHex}`;
    csvLines.push(lineWithCrc);
    if (csvLines.length > 3600) csvLines = [csvLines[0], ...csvLines.slice(-3600)];
  }, 1000);
}

document.addEventListener("DOMContentLoaded", main);

