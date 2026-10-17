let API = "https://api.tvmaze.com";
let MAX_RESULTS = 10;
let MAX_CAST = 5;
let NA = "Not available";

// Caches avoid repeat requests for data we already have. Failures are never cached.
let searchCache = new Map(); // lowercase query -> array of shows
let castCache = new Map();   // show id -> array of cast names

let form = document.getElementById("search-form");
let input = document.getElementById("query");
let gallery = document.getElementById("gallery");
let statusEl = document.getElementById("status");

// Guards against an older, slower search overwriting a newer one.
let searchCounter = 0;

/**
 * Shows a message in the status area under the search form.
 * @param {string} message : the text to display
 * @param {boolean} isError : true if the message describes an error
 */
function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.className = isError ? "error" : "";
}

/**
 * Fetches a URL and parses the JSON, checking the HTTP status first.
 * @param {string} url : the URL to request
 * @return {Promise<any>} : the parsed JSON response
 * @throws {Error} : on an HTTP error or unreadable JSON; rateLimited is true on an HTTP 429
 */
async function fetchJSON(url) {
  let response = await fetch(url);
  if (response.status === 429) {
    let limitError = new Error("TVmaze is limiting requests right now. Please wait a moment and try again.");
    limitError.rateLimited = true;
    throw limitError;
  }
  if (!response.ok) {
    throw new Error("TVmaze returned an error (HTTP " + response.status + ").");
  }
  try {
    return await response.json();
  } catch (err) {
    throw new Error("TVmaze sent a response that could not be read. Please try again.");
  }
}

/**
 * Converts an HTML string to plain text without inserting it into the page.
 * @param {string} html : HTML markup, possibly null or empty
 * @return {string} : the text content with all markup removed
 */
function htmlToText(html) {
  if (!html) {
    return "";
  }
  let doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent || "").trim();
}

/**
 * Shortens text to a maximum length, adding an ellipsis if it was cut.
 * @param {string} text : the text to shorten
 * @param {number} max : the maximum number of characters to keep
 * @return {string} : the original or shortened text
 */
function truncate(text, max) {
  return text.length > max ? text.slice(0, max).trimEnd() + "\u2026" : text;
}

/**
 * Formats a TVmaze premiere date (YYYY-MM-DD) for display.
 * @param {string} value : the date string, possibly null
 * @return {string} : a readable date, or "Not available"
 */
function formatDate(value) {
  if (!value) {
    return NA;
  }
  // Premiere dates are plain YYYY-MM-DD; parse as local time to avoid an off-by-one day.
  let date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + "T00:00:00") : new Date(value);
  return isNaN(date) ? NA : date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

/**
 * Formats the TVmaze "updated" value, a Unix timestamp in seconds.
 * @param {number} seconds : seconds since 1970, possibly null
 * @return {string} : a readable date and time, or "Not available"
 */
function formatUpdated(seconds) {
  if (!seconds) {
    return NA;
  }
  let date = new Date(seconds * 1000);
  return isNaN(date) ? NA : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Adds a term/description pair to a description list.
 * @param {HTMLElement} dl : the dl element to add to
 * @param {string} term : the label text
 * @param {string} value : the value text
 * @return {HTMLElement} : the dd element, so its text can be changed later
 */
function addRow(dl, term, value) {
  let dt = document.createElement("dt");
  dt.textContent = term;
  let dd = document.createElement("dd");
  dd.textContent = value;
  dl.appendChild(dt);
  dl.appendChild(dd);
  return dd;
}

/**
 * Builds the card for one show and starts loading its cast.
 * @param {Object} show : a show object from the TVmaze search results
 * @return {HTMLElement} : the finished card element
 */
function buildCard(show) {
  let card = document.createElement("article");
  card.className = "card";

  if (show.image && (show.image.medium || show.image.original)) {
    let img = document.createElement("img");
    img.className = "poster";
    img.src = (show.image.medium || show.image.original).replace(/^http:/, "https:");
    img.alt = "Poster for " + show.name;
    img.loading = "lazy";
    card.appendChild(img);
  } else {
    let noPoster = document.createElement("div");
    noPoster.className = "no-poster";
    noPoster.textContent = "Poster not available";
    card.appendChild(noPoster);
  }

  let body = document.createElement("div");
  body.className = "card-body";

  let title = document.createElement("h2");
  title.textContent = show.name || "Untitled show";
  body.appendChild(title);

  let summaryText = htmlToText(show.summary);
  let summary = document.createElement("p");
  summary.className = "summary";
  summary.textContent = summaryText ? truncate(summaryText, 220) : "Summary not available";
  body.appendChild(summary);

  let dl = document.createElement("dl");
  addRow(dl, "Premiered", formatDate(show.premiered));
  addRow(dl, "Last updated", formatUpdated(show.updated));
  addRow(dl, "Genres", show.genres && show.genres.length ? show.genres.join(", ") : NA);
  let rating = show.rating && typeof show.rating.average === "number" ? show.rating.average + " / 10" : NA;
  addRow(dl, "Rating", rating);
  let castCell = addRow(dl, "Main cast", "Loading\u2026");
  body.appendChild(dl);

  if (show.url) {
    let link = document.createElement("a");
    link.textContent = "View on TVmaze";
    link.href = show.url;
    link.target = "_blank";
    link.rel = "noopener";
    body.appendChild(link);
  }

  card.appendChild(body);
  loadCast(show.id, castCell);
  return card;
}

/**
 * Makes the second fetch request, for one show's cast, and displays the names.
 * A failure only affects that show's card.
 * @param {number} showId : the TVmaze ID of the show
 * @param {HTMLElement} cell : the element that will display the cast names
 */
async function loadCast(showId, cell) {
  if (castCache.has(showId)) {
    let cached = castCache.get(showId);
    cell.textContent = cached.length ? cached.join(", ") : NA;
    return;
  }
  try {
    let cast = await fetchJSON(API + "/shows/" + showId + "/cast");
    let names = cast
      .slice(0, MAX_CAST)
      .map(entry => entry && entry.person && entry.person.name)
      .filter(Boolean);
    castCache.set(showId, names);
    cell.textContent = names.length ? names.join(", ") : NA;
  } catch (err) {
    cell.textContent = err.rateLimited
      ? "Cast unavailable: TVmaze rate limit reached. Search again in a moment."
      : NA;
  }
}

/**
 * Searches TVmaze for shows and replaces the gallery with the results.
 * @param {string} term : the visitor's search text
 */
async function search(term) {
  let query = term.trim();
  let thisSearch = ++searchCounter;

  gallery.innerHTML = ""; // clear any stale results right away

  if (!query) {
    setStatus("Enter a show title or keyword to search.");
    return;
  }

  setStatus("Searching for \u201C" + query + "\u201D\u2026");

  try {
    let cacheKey = query.toLowerCase();
    let shows = searchCache.get(cacheKey);
    if (!shows) {
      let results = await fetchJSON(API + "/search/shows?q=" + encodeURIComponent(query));
      if (thisSearch !== searchCounter) {
        return;
      }
      shows = results
        .map(item => item && item.show)
        .filter(Boolean)
        .slice(0, MAX_RESULTS);
      searchCache.set(cacheKey, shows);
    }

    if (shows.length === 0) {
      setStatus("No shows matched \u201C" + query + "\u201D. Try a different title or keyword.");
      return;
    }

    setStatus("Showing " + shows.length + " result" + (shows.length === 1 ? "" : "s") + " for \u201C" + query + "\u201D.");
    shows.forEach(show => gallery.appendChild(buildCard(show)));
  } catch (err) {
    if (thisSearch !== searchCounter) {
      return;
    }
    let offline = err instanceof TypeError;
    setStatus(
      offline ? "The request failed. Check your connection and try again." : err.message,
      true
    );
  }
}

/**
 * Runs a search when the visitor submits the form.
 * @param {Event} event : the submit event
 */
function handleSubmit(event) {
  event.preventDefault();
  search(input.value);
}

form.addEventListener("submit", handleSubmit);

// Default search on first load.
input.value = "mystery";
search("mystery");