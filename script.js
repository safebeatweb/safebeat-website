import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js"
import { getDatabase, limitToLast, onValue, query, ref, get as dbGet } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-database.js"
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, updatePassword } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js"
import { getFirestore, doc, setDoc, getDoc, updateDoc, collection, addDoc, deleteDoc, query as fsQuery, orderBy, limit, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js"

const config = {
  apiKey: "AIzaSyAm2p01fVffl6FGh46J2xmMzjAA7D4Kl4k",
  authDomain: "genius-final.firebaseapp.com",
  databaseURL: "https://genius-final-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "genius-final",
  storageBucket: "genius-final.firebasestorage.app",
  messagingSenderId: "607410607791",
  appId: "1:607410607791:web:bb080df6399bebc166a65a"
}

// The website's whole backend (chatbot, contact form, and AI ECG
// analysis) is one combined Flask app (see the SafeBeat_Backend
// folder), deployed for free on Render.com. Replace this with your
// Render service's real URL once it's live, e.g.
// "https://safebeat-backend.onrender.com"
const BACKEND_URL = "https://safebeat-backend.onrender.com"

// Small safety helper: attaches a listener only if the element actually
// exists on the page. This prevents one missing/renamed element ID from
// crashing the entire script (and silently breaking every feature that
// comes after it in the file) — instead it just logs a warning and the
// rest of the page keeps working normally.
function onClick(element, handler) {
  if (!element) {
    console.warn("SafeBeat: expected element not found, skipping its click handler.")
    return
  }
  element.addEventListener("click", handler)
}

function onSubmit(element, handler) {
  if (!element) {
    console.warn("SafeBeat: expected form not found, skipping its submit handler.")
    return
  }
  element.addEventListener("submit", handler)
}

const menu = document.getElementById("menu")
const nav = document.getElementById("nav")
const openConsole = document.getElementById("open-console")
const closeConsole = document.getElementById("close-console")
const status = document.getElementById("connection-status")
const heartRate = document.getElementById("hr-web")
const spo2 = document.getElementById("spo2-web")
const messages = document.getElementById("messages")
const question = document.getElementById("question")
const chatForm = document.getElementById("chat-form")
const clearChat = document.getElementById("clear-chat")
const contactForm = document.getElementById("contact-form")
const formStatus = document.getElementById("form-status")

let database
let firebaseApp
let auth
let firestore
let chart
let dataBuffer = Array(150).fill(0)
let lastSignal = 0
let state = "connecting"
let latestHeartRate = null
let latestSpO2 = null
let latestArrhythmiaRisk = null

function showState(next) {
  state = next
  status.className = next
  status.textContent = next === "connected" ? "Unit connected" : next === "disconnected" ? "Disconnected" : "Connecting..."
}

function getValue(value) {
  if (value === null || value === undefined) return "--"
  if (typeof value === "object") return value.status || Object.values(value)[0] || "--"
  return value
}

function toMillivolts(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  const result = ((number / 4095) * 3.3 - ((2048 / 4095) * 3.3)) * 1000
  return Math.max(-1000, Math.min(1000, result))
}

function makeChart() {
  if (chart || !window.Chart) return
  chart = new Chart(document.getElementById("liveEcg"), {
    type: "line",
    data: {
      labels: Array(150).fill(""),
      datasets: [{
        data: dataBuffer,
        borderColor: "#9e5c67",
        borderWidth: 1.6,
        pointRadius: 0,
        tension: .1,
        fill: true,
        backgroundColor: "rgba(158, 92, 103, .10)"
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { display: false },
        y: { min: -1000, max: 1000, ticks: { display: false }, grid: { color: "rgba(158, 92, 103, .10)" } }
      },
      plugins: { legend: { display: false }, tooltip: { enabled: false } }
    }
  })
}

function updateChart() {
  if (!chart) return
  chart.data.datasets[0].data = dataBuffer
  chart.update("none")
}

function addMessage(text, type) {
  const message = document.createElement("p")
  message.className = type
  message.textContent = text
  messages.appendChild(message)
  messages.scrollTop = messages.scrollHeight
  return message
}

function openMonitor() {
  document.body.classList.add("console-open")
  window.scrollTo(0, 0)
  makeChart()
  setTimeout(() => chart && chart.resize(), 100)
}

menu.addEventListener("click", () => {
  const open = nav.classList.toggle("open")
  menu.textContent = open ? "Close" : "Menu"
  menu.setAttribute("aria-expanded", open)
})

nav.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    nav.classList.remove("open")
    menu.textContent = "Menu"
    menu.setAttribute("aria-expanded", "false")
  })
})

openConsole.addEventListener("click", openMonitor)
closeConsole.addEventListener("click", () => {
  document.body.classList.remove("console-open")
  window.scrollTo(0, 0)
})

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"))
    document.querySelectorAll(".console-tab").forEach((item) => item.classList.remove("active"))
    button.classList.add("active")
    document.getElementById(button.dataset.tab).classList.add("active")
  })
})

clearChat.addEventListener("click", () => {
  messages.innerHTML = ""
  addMessage("Hello. I can answer questions about the SafeBeat project. What would you like to know?", "bot-message")
  question.focus()
})

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault()
  const text = question.value.trim()
  if (!text) return

  addMessage(text, "user-message")
  question.value = ""
  question.disabled = true
  const loading = addMessage("Thinking...", "bot-message loading-message")

  try {
    const response = await fetch(`${BACKEND_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text })
    })
    const data = await response.json()
    loading.remove()
    addMessage(data.reply || "I could not answer that right now.", "bot-message")
  } catch (error) {
    loading.remove()
    addMessage("The assistant is temporarily unavailable. Please try again later.", "bot-message")
  }

  question.disabled = false
  question.focus()
})

try {
  firebaseApp = initializeApp(config)
  database = getDatabase(firebaseApp)
  auth = getAuth(firebaseApp)
  firestore = getFirestore(firebaseApp)

  onValue(ref(database, "ECG/status"), (snapshot) => {
    const value = String(snapshot.val() || "").toLowerCase()
    if (value.includes("connected")) {
      lastSignal = Date.now()
      showState("connected")
    }
  }, () => showState("disconnected"))

  onValue(query(ref(database, "ECG/data"), limitToLast(150)), (snapshot) => {
    if (!snapshot.exists()) return
    const data = snapshot.val()
    const values = Object.keys(data).sort((a, b) => Number(a) - Number(b)).map((key) => toMillivolts(data[key]))
    dataBuffer = Array(Math.max(0, 150 - values.length)).fill(0).concat(values.slice(-150))
    lastSignal = Date.now()
    showState("connected")
    updateChart()
  }, () => showState("disconnected"))

  onValue(ref(database, "HeartRate"), (snapshot) => {
    const value = getValue(snapshot.val())
    heartRate.textContent = value
    latestHeartRate = Number(value)
    if (!Number.isFinite(latestHeartRate)) latestHeartRate = null
    runAlertSystem()
  }, () => {
    heartRate.textContent = "--"
    latestHeartRate = null
    runAlertSystem()
  })

  onValue(ref(database, "SpO2"), (snapshot) => {
    const value = getValue(snapshot.val())
    spo2.textContent = value
    latestSpO2 = Number(value)
    if (!Number.isFinite(latestSpO2)) latestSpO2 = null
    runAlertSystem()
  }, () => {
    spo2.textContent = "--"
    latestSpO2 = null
    runAlertSystem()
  })
} catch (error) {
  showState("disconnected")
}

contactForm.addEventListener("submit", async (event) => {
  event.preventDefault()
  const button = contactForm.querySelector("button")
  formStatus.textContent = "Sending..."
  button.disabled = true

  try {
    const response = await fetch(`${BACKEND_URL}/save_user`, {
      method: "POST",
      body: new FormData(contactForm)
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.message)
    contactForm.reset()
    formStatus.textContent = data.message
  } catch (error) {
    formStatus.textContent = error.message || "The message could not be saved."
  }

  button.disabled = false
})

setInterval(() => {
  if (state === "connected" && Date.now() - lastSignal > 5000) showState("disconnected")
}, 1000)

const runAnalysisButton = document.getElementById("run-analysis")
const analysisStatus = document.getElementById("analysis-status")
const analysisResults = document.getElementById("analysis-results")
const analysisRiskBadge = document.getElementById("analysis-risk-badge")
const analysisBeatCount = document.getElementById("analysis-beat-count")
const analysisLabelCounts = document.getElementById("analysis-label-counts")

// Reuses the same combined backend URL declared above for Firebase/chat.
const ANALYSIS_API_URL = BACKEND_URL

if (runAnalysisButton) {
  runAnalysisButton.addEventListener("click", async () => {
    analysisStatus.textContent = "Analyzing latest signal..."
    analysisResults.hidden = true
    runAnalysisButton.disabled = true

    try {
      const response = await fetch(`${ANALYSIS_API_URL}/analyze_latest?window_seconds=10`)
      const data = await response.json()

      if (!response.ok) {
        analysisStatus.textContent = data.error || "The analysis service could not process this request."
        return
      }

      if (data.beats_analyzed === 0) {
        analysisStatus.textContent = data.message || "No heartbeats detected."
        return
      }

      analysisStatus.textContent = ""
      analysisResults.hidden = false
      analysisRiskBadge.textContent = data.overall_risk
      analysisRiskBadge.className = `risk-badge risk-${data.overall_risk}`
      analysisBeatCount.textContent = `${data.beats_analyzed} beats analyzed`

      analysisLabelCounts.innerHTML = ""
      Object.entries(data.label_counts).forEach(([label, count]) => {
        const row = document.createElement("div")
        row.className = "label-count-row"
        row.innerHTML = `<span>${label}</span><strong>${count}</strong>`
        analysisLabelCounts.appendChild(row)
      })
    } catch (error) {
      analysisStatus.textContent =
        "The analysis service is temporarily unavailable. Please try again shortly."
    } finally {
      runAnalysisButton.disabled = false
    }
  })
}

// ---------------------------------------------------------------------
// Continuous auto-analysis for the Monitor tab (no button, runs on its
// own). Every few seconds it quietly asks the analysis API "what does
// the last few seconds of signal look like?" and updates a small badge
// under the live ECG chart. This is what should catch an emergency
// pattern automatically while an athlete is training, without anyone
// needing to click anything.
// ---------------------------------------------------------------------
const autoBadge = document.getElementById("auto-analysis-badge")
const autoDetail = document.getElementById("auto-analysis-detail")
const AUTO_ANALYSIS_INTERVAL_MS = 8000 // check every 8 seconds

async function runAutoAnalysis() {
  if (!autoBadge) return // this element only exists on the Monitor tab

  try {
    const response = await fetch(`${ANALYSIS_API_URL}/analyze_latest?window_seconds=10`)
    const data = await response.json()

    if (!response.ok) {
      autoBadge.textContent = "Analysis unavailable"
      autoBadge.className = "risk-badge"
      autoDetail.textContent = data.error || ""
      latestArrhythmiaRisk = null
      runAlertSystem()
      return
    }

    if (data.beats_analyzed === 0) {
      autoBadge.textContent = "No signal detected"
      autoBadge.className = "risk-badge"
      autoDetail.textContent = data.message || ""
      latestArrhythmiaRisk = null
      runAlertSystem()
      return
    }

    autoBadge.textContent =
      data.overall_risk === "alert" ? "Emergency pattern detected" :
      data.overall_risk === "monitor" ? "Irregularity detected" :
      "Rhythm normal"
    autoBadge.className = `risk-badge risk-${data.overall_risk}`
    autoDetail.textContent = `${data.beats_analyzed} beats analyzed in the last 10 seconds`
    latestArrhythmiaRisk = data.overall_risk
    runAlertSystem()
  } catch (error) {
    autoBadge.textContent = "Analysis service offline"
    autoBadge.className = "risk-badge"
    autoDetail.textContent = "Continuous analysis is temporarily unavailable."
    latestArrhythmiaRisk = null
    runAlertSystem()
  }
}

if (autoBadge) {
  runAutoAnalysis()
  setInterval(runAutoAnalysis, AUTO_ANALYSIS_INTERVAL_MS)
}

// ---------------------------------------------------------------------
// Full alert system (below the AI panel on the AI analysis tab).
// Mirrors fig6 / the Results paragraph: it checks the same three
// early-warning signs in sequence — arrhythmia pattern (from the AI
// model), then heart rate (brady/tachycardia), then SpO2 — and combines
// them into one plain verdict: "Athlete safe" unless one of the three
// checks crosses its threshold, in which case it raises an alert.
// ---------------------------------------------------------------------
const HR_LOW_BPM = 40      // below this = bradycardia concern
const HR_HIGH_BPM = 180    // above this = tachycardia concern
const SPO2_LOW_PERCENT = 90 // below this = low oxygen concern

const stepArrhythmiaBadge = document.getElementById("step-arrhythmia-badge")
const stepHrBadge = document.getElementById("step-hr-badge")
const stepSpo2Badge = document.getElementById("step-spo2-badge")
const alertVerdict = document.getElementById("alert-verdict")
const alertVerdictText = document.getElementById("alert-verdict-text")

function setStepBadge(el, tier, label) {
  if (!el) return
  el.textContent = label
  el.className = `step-badge risk-badge risk-${tier}`
}

function runAlertSystem() {
  if (!alertVerdict) return // only present on the AI analysis tab

  // Step 1 — arrhythmia, from the live AI heartbeat classification.
  let arrhythmiaTier = "normal"
  if (latestArrhythmiaRisk === null) {
    setStepBadge(stepArrhythmiaBadge, "monitor", "No data")
  } else {
    arrhythmiaTier = latestArrhythmiaRisk
    setStepBadge(
      stepArrhythmiaBadge,
      arrhythmiaTier,
      arrhythmiaTier === "alert" ? "Irregular" : arrhythmiaTier === "monitor" ? "Watch" : "Normal"
    )
  }

  // Step 2 — heart rate, checked next, same brady/tachy zones as fig13.
  let hrTier = "normal"
  if (latestHeartRate === null) {
    setStepBadge(stepHrBadge, "monitor", "No data")
  } else if (latestHeartRate < HR_LOW_BPM || latestHeartRate > HR_HIGH_BPM) {
    hrTier = "alert"
    setStepBadge(stepHrBadge, "alert", `${latestHeartRate} BPM`)
  } else {
    setStepBadge(stepHrBadge, "normal", `${latestHeartRate} BPM`)
  }

  // Step 3 — SpO2, checked last, same threshold as fig14.
  let spo2Tier = "normal"
  if (latestSpO2 === null) {
    setStepBadge(stepSpo2Badge, "monitor", "No data")
  } else if (latestSpO2 < SPO2_LOW_PERCENT) {
    spo2Tier = "alert"
    setStepBadge(stepSpo2Badge, "alert", `${latestSpO2}%`)
  } else {
    setStepBadge(stepSpo2Badge, "normal", `${latestSpO2}%`)
  }

  // Combine the three checks into one verdict, same logic as the
  // Results paragraph: if any of the three tracked warning signs
  // crosses its safe range, raise an alert; otherwise the athlete
  // is reported safe.
  const tiers = [arrhythmiaTier, hrTier, spo2Tier]
  let verdict = "safe"
  let message = "Athlete safe — all vitals within normal range."

  if (tiers.includes("alert")) {
    verdict = "alert"
    message = "Alert — abnormal reading detected, notify athlete & medical team."
  } else if (tiers.includes("monitor")) {
    verdict = "monitor"
    message = "Monitoring — a reading needs a closer look."
  }

  alertVerdict.className = `alert-verdict ${verdict}`
  alertVerdictText.textContent = message
}

// ---------------------------------------------------------------------
// Personalized diagnostic tab — login-gated, matching the same Firebase
// Auth + Firestore logic as the SafeBeat Flutter app (same account,
// same "users/{uid}" profile fields, same target-BPM/BMI/history math).
//
// Flow: a blurred diagnostic screen sits behind a centered overlay.
//   - Not signed in -> overlay shows Login / Register tabs.
//   - Login -> just authenticates, no profile step, straight to unlocked.
//   - Register -> creates the account, then shows a one-time personal
//     info step (age/height/weight/etc, same fields as the Flutter
//     app's BodyInfoScreen) before unlocking.
//   - Once unlocked, a gear button in the sidebar reopens the same
//     personal info step at any time to edit/save.
// ---------------------------------------------------------------------
const diagAuthStatus = document.getElementById("diagnostic-auth-status")
const diagContent = document.getElementById("diagnostic-content")
const diagOverlay = document.getElementById("diagnostic-overlay")
const authStep = document.getElementById("auth-step")
const profileStep = document.getElementById("profile-step")
const editProfileBtn = document.getElementById("edit-profile-btn")

const tabLoginBtn = document.getElementById("tab-login")
const tabRegisterBtn = document.getElementById("tab-register")
const loginForm = document.getElementById("login-form")
const registerForm = document.getElementById("register-form")
const loginStatus = document.getElementById("login-status")
const registerStatus = document.getElementById("register-status")

const setupAge = document.getElementById("setup-age")
const setupHeight = document.getElementById("setup-height")
const setupWeight = document.getElementById("setup-weight")
const setupRestingHr = document.getElementById("setup-resting-hr")
const setupGender = document.getElementById("setup-gender")
const setupActivity = document.getElementById("setup-activity")
const setupFetchHrBtn = document.getElementById("setup-fetch-hr")
const setupStatus = document.getElementById("setup-status")
const setupFinishBtn = document.getElementById("setup-finish")
const setupPasswordSection = document.getElementById("setup-password-section")
const setupNewPassword = document.getElementById("setup-new-password")
const setupLogoutBtn = document.getElementById("setup-logout")

const diagTargetBpm = document.getElementById("diag-target-bpm")
const diagLiveBpm = document.getElementById("diag-live-bpm")
const diagMaxBpm = document.getElementById("diag-max-bpm")
const diagLiveSpo2 = document.getElementById("diag-live-spo2")
const diagTimer = document.getElementById("diag-timer")
const diagStartStopBtn = document.getElementById("diag-start-stop")
const diagHistoryList = document.getElementById("diagnostic-history-list")
const diagnosticResultCard = document.getElementById("diagnostic-result-card")
const diagnosticResultBadge = document.getElementById("diagnostic-result-badge")
const resultMaxBpm = document.getElementById("result-max-bpm")
const resultTarget = document.getElementById("result-target")
const resultSpo2 = document.getElementById("result-spo2")
const resultBmi = document.getElementById("result-bmi")
const diagnosticResultDismiss = document.getElementById("diagnostic-result-dismiss")

if (diagnosticResultDismiss) {
  diagnosticResultDismiss.addEventListener("click", () => {
    diagnosticResultCard.hidden = true
  })
}

let currentUser = null
let currentProfile = null
let diagRunning = false
let diagElapsedSeconds = 0
let diagMaxBpmSeen = 0
let diagBpmReadings = []
let diagSpo2Readings = []
let diagIntervalId = null
let historyUnsubscribe = null

let isEditingExistingProfile = false

function showAuthStep() {
  authStep.hidden = false
  profileStep.hidden = true
  diagOverlay.hidden = false
  diagContent.classList.add("diagnostic-locked")
}

function showProfileStep(isEditing) {
  isEditingExistingProfile = !!isEditing
  authStep.hidden = true
  profileStep.hidden = false
  diagOverlay.hidden = false
  diagContent.classList.add("diagnostic-locked")

  // Password change + logout only make sense when reopening an existing
  // profile via the gear icon — not during first-time register setup.
  setupPasswordSection.hidden = !isEditingExistingProfile
  setupLogoutBtn.hidden = !isEditingExistingProfile
  setupNewPassword.value = ""
}

function showUnlocked() {
  diagOverlay.hidden = true
  diagContent.classList.remove("diagnostic-locked")
}

if (tabLoginBtn) {
  tabLoginBtn.addEventListener("click", () => {
    tabLoginBtn.classList.add("active")
    tabRegisterBtn.classList.remove("active")
    loginForm.hidden = false
    registerForm.hidden = true
  })

  tabRegisterBtn.addEventListener("click", () => {
    tabRegisterBtn.classList.add("active")
    tabLoginBtn.classList.remove("active")
    registerForm.hidden = false
    loginForm.hidden = true
  })

  // Show/hide password toggles — shared helper for every password field
  // on the login, register, and profile-edit forms.
  function wirePasswordToggle(toggleId, inputId) {
    const toggleBtn = document.getElementById(toggleId)
    const input = document.getElementById(inputId)
    if (!toggleBtn || !input) return
    toggleBtn.addEventListener("click", () => {
      const showing = input.type === "text"
      input.type = showing ? "password" : "text"
      toggleBtn.textContent = showing ? "👁" : "🙈"
      toggleBtn.title = showing ? "Show password" : "Hide password"
    })
  }

  wirePasswordToggle("login-password-toggle", "login-password")
  wirePasswordToggle("register-password-toggle", "register-password")
  wirePasswordToggle("setup-password-toggle", "setup-new-password")

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault()
    loginStatus.textContent = "Signing in..."
    try {
      // Login just authenticates — no profile step, straight to unlocked.
      await signInWithEmailAndPassword(auth, document.getElementById("login-email").value.trim(), document.getElementById("login-password").value)
      loginStatus.textContent = ""
      loginForm.reset()
    } catch (error) {
      loginStatus.textContent = "Invalid credentials. Please try again."
    }
  })

  registerForm.addEventListener("submit", async (event) => {
    event.preventDefault()
    registerStatus.textContent = "Creating your unit..."
    const username = document.getElementById("register-username").value.trim()
    const email = document.getElementById("register-email").value.trim()
    const password = document.getElementById("register-password").value

    try {
      const credential = await createUserWithEmailAndPassword(auth, email, password)
      await setDoc(doc(firestore, "users", credential.user.uid), {
        username,
        email,
        createdAt: serverTimestamp()
      })
      registerStatus.textContent = ""
      registerForm.reset()
      // onAuthStateChanged below will detect the new user has no
      // profile fields yet and route straight to the profile step.
    } catch (error) {
      registerStatus.textContent = error.message.includes("email-already-in-use")
        ? "That email is already registered — try logging in instead."
        : "Could not register. " + (error.message || "")
    }
  })

  editProfileBtn.addEventListener("click", () => {
    if (!currentUser) return
    populateProfileStepFields(currentProfile || {})
    showProfileStep(true)
  })

  setupFetchHrBtn.addEventListener("click", async () => {
    const snapshot = await dbGet(ref(database, "HeartRate"))
    if (snapshot.exists()) setupRestingHr.value = snapshot.val()
  })

  setupLogoutBtn.addEventListener("click", () => signOut(auth))

  setupFinishBtn.addEventListener("click", async () => {
    if (!currentUser) return
    setupStatus.textContent = "Saving..."
    try {
      const profileData = {
        age: setupAge.value,
        height: `${setupHeight.value} cm`,
        weight: `${setupWeight.value} kg`,
        resting_heart_rate: setupRestingHr.value,
        gender: setupGender.value,
        activity_level: setupActivity.value
      }
      await updateDoc(doc(firestore, "users", currentUser.uid), profileData)
      currentProfile = { ...currentProfile, ...profileData }

      // Optional password change — only attempted if a new password was
      // actually typed in, so leaving it blank keeps the current one.
      if (setupNewPassword.value) {
        try {
          await updatePassword(currentUser, setupNewPassword.value)
        } catch (passwordError) {
          setupStatus.textContent = "Profile saved, but password could not be changed — please log out and back in, then try again."
          setupNewPassword.value = ""
          return
        }
      }

      setupStatus.textContent = ""
      setupNewPassword.value = ""
      showUnlocked()
    } catch (error) {
      setupStatus.textContent = "Could not save profile."
    }
  })

  onAuthStateChanged(auth, async (user) => {
    currentUser = user

    if (user) {
      diagAuthStatus.textContent = "Signed in"
      editProfileBtn.hidden = false
      const snapshot = await getDoc(doc(firestore, "users", user.uid))
      currentProfile = snapshot.exists() ? snapshot.data() : {}

      if (!currentProfile.age) {
        // New/incomplete profile (fresh register) -> one-time setup step.
        populateProfileStepFields(currentProfile)
        showProfileStep(false)
      } else {
        showUnlocked()
      }

      subscribeHistory()
    } else {
      diagAuthStatus.textContent = "Not signed in"
      editProfileBtn.hidden = true
      currentProfile = null
      showAuthStep()
      stopDiagnosisTimer()
      if (historyUnsubscribe) historyUnsubscribe()
    }
  })
}

function populateProfileStepFields(data) {
  setupAge.value = data.age || ""
  setupHeight.value = data.height ? String(data.height).split(" ")[0] : ""
  setupWeight.value = data.weight ? String(data.weight).split(" ")[0] : ""
  setupRestingHr.value = data.resting_heart_rate ? String(data.resting_heart_rate).replace(/[^0-9]/g, "") : ""
  setupGender.value = data.gender || "Male"
  setupActivity.value = data.activity_level || "Moderate"
  setupStatus.textContent = ""
}

// Same target-BPM formula as the Flutter app's calculateAlertThreshold():
// target = restingHR + ((HRmax - restingHR) * activityFactor)
function calculateTargetBpm() {
  const age = Number(currentProfile && currentProfile.age) || 30
  const restingHr = Number(currentProfile && String(currentProfile.resting_heart_rate).replace(/[^0-9]/g, "")) || 70
  const hrmax = 220 - age
  const activity = ((currentProfile && currentProfile.activity_level) || "moderate").toLowerCase()
  const factor = activity === "high" ? 0.95 : activity === "low" ? 0.85 : 0.9
  return Math.round(restingHr + (hrmax - restingHr) * factor)
}

function stopDiagnosisTimer() {
  diagRunning = false
  if (diagIntervalId) clearInterval(diagIntervalId)
  diagIntervalId = null
}

if (diagStartStopBtn) {
  diagStartStopBtn.addEventListener("click", () => {
    if (diagRunning) {
      finishDiagnosis()
    } else {
      startDiagnosis()
    }
  })
}

function startDiagnosis() {
  diagRunning = true
  diagElapsedSeconds = 0
  diagMaxBpmSeen = 0
  diagBpmReadings = []
  diagSpo2Readings = []
  diagStartStopBtn.textContent = "Stop diagnosis"
  diagMaxBpm.textContent = "0"
  diagTimer.textContent = "0 / 60"
  if (diagnosticResultCard) diagnosticResultCard.hidden = true

  diagIntervalId = setInterval(() => {
    if (latestHeartRate !== null) {
      diagBpmReadings.push(latestHeartRate)
      if (latestHeartRate > diagMaxBpmSeen) diagMaxBpmSeen = latestHeartRate
      diagLiveBpm.textContent = latestHeartRate
      diagMaxBpm.textContent = diagMaxBpmSeen
    }
    if (latestSpO2 !== null) {
      diagSpo2Readings.push(latestSpO2)
      diagLiveSpo2.textContent = `${latestSpO2}%`
    }

    diagElapsedSeconds += 1
    diagTimer.textContent = `${diagElapsedSeconds} / 60`

    if (diagElapsedSeconds >= 60) finishDiagnosis()
  }, 1000)
}

async function finishDiagnosis() {
  stopDiagnosisTimer()
  diagStartStopBtn.textContent = "Start diagnosis"

  const avgSpo2 = diagSpo2Readings.length
    ? Math.round(diagSpo2Readings.reduce((a, b) => a + b, 0) / diagSpo2Readings.length)
    : (latestSpO2 || 0)

  const target = calculateTargetBpm()
  diagTargetBpm.textContent = `${target}`

  const heightM = (Number(currentProfile && String(currentProfile.height).split(" ")[0]) || 0) / 100
  const weightKg = Number(currentProfile && String(currentProfile.weight).split(" ")[0]) || 0
  const bmi = heightM > 0 ? weightKg / (heightM * heightM) : 0

  const statusLabel = diagMaxBpmSeen >= target ? "Optimal" : "Below Target"

  if (currentUser) {
    try {
      await addDoc(collection(firestore, "users", currentUser.uid, "history"), {
        date: serverTimestamp(),
        max_bpm: diagMaxBpmSeen,
        avg_spo2: avgSpo2,
        target_bpm: target,
        bmi,
        status: statusLabel
      })
    } catch (error) {
      // history save failing shouldn't block showing the result
    }
  }

  resultMaxBpm.textContent = diagMaxBpmSeen
  resultTarget.textContent = target
  resultSpo2.textContent = `${avgSpo2}%`
  resultBmi.textContent = bmi.toFixed(1)
  diagnosticResultBadge.textContent = statusLabel === "Optimal" ? "Optimal" : "Below target"
  diagnosticResultBadge.className = `step-badge risk-badge ${statusLabel === "Optimal" ? "risk-normal" : "risk-monitor"}`
  diagnosticResultCard.hidden = false
}

function subscribeHistory() {
  if (!currentUser) return
  if (historyUnsubscribe) historyUnsubscribe()

  const historyQuery = fsQuery(
    collection(firestore, "users", currentUser.uid, "history"),
    orderBy("date", "desc"),
    limit(20)
  )

  historyUnsubscribe = onSnapshot(historyQuery, (snapshot) => {
    if (snapshot.empty) {
      diagHistoryList.innerHTML = `<p class="diagnostic-history-empty">No sessions recorded.</p>`
      return
    }

    diagHistoryList.innerHTML = ""
    snapshot.forEach((docSnap) => {
      const data = docSnap.data()
      const date = data.date && data.date.toDate ? data.date.toDate() : new Date()
      const timeLabel = `${date.getDate()}/${date.getMonth() + 1} • ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`

      const item = document.createElement("div")
      item.className = "diagnostic-history-item"
      item.innerHTML = `
        <div class="history-left">
          <small>${timeLabel}</small>
          <strong style="color: ${data.status === "Optimal" ? "#217242" : "var(--pink-dark)"}">${data.status || "--"}</strong>
          <div style="color: var(--text); font-size: 10px; margin-top: 4px;">BMI: ${(data.bmi || 0).toFixed(1)} | Target: ${data.target_bpm ?? "--"}</div>
        </div>
        <div class="history-right">
          <strong>${data.max_bpm ?? "--"} BPM</strong>
          <span>O2: ${data.avg_spo2 ?? "--"}%</span>
        </div>
        <button class="diagnostic-history-delete" title="Delete">✕</button>
      `
      item.querySelector(".diagnostic-history-delete").addEventListener("click", async () => {
        try {
          await deleteDoc(doc(firestore, "users", currentUser.uid, "history", docSnap.id))
        } catch (error) {
          // ignore delete failure, snapshot listener will just keep showing it
        }
      })
      diagHistoryList.appendChild(item)
    })
  })
}
