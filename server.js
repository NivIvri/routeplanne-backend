const path = require('path');
const envPath = path.resolve(__dirname, '.env');
require('dotenv').config({ path: envPath });



const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bodyParser = require("body-parser");
const auth = require('./middleware/auth');
const fetch = global.fetch || ((...args) => import('node-fetch').then(({default: f}) => f(...args)));

const app = express();
app.use(cors());
app.use(bodyParser.json());
// Import models
const User = require('./models/User');
const Route = require('./models/Route');

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI ;
mongoose.connect(MONGODB_URI)
  .then(() => console.log('Connected to MongoDB Atlas'))
  .catch(err => console.error('MongoDB connection error:', err));

// Register endpoint
app.post("/api/register", async (req, res) => {
  try {
    const { email, username, password } = req.body;
    
    if (!email || !username || !password) {
      return res.status(400).json({ message: "Email, username, and password are required" });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ 
      $or: [{ username }, { email }] 
    });
    
    if (existingUser) {
      return res.status(400).json({ message: "Username or email already exists" });
    }

    // Create new user (password will be hashed automatically)
    const newUser = new User({ email, username, password });
    await newUser.save();

    // Generate JWT token
    const token = newUser.generateAuthToken();

    res.status(201).json({ 
      message: "User registered successfully",
      token,
      user: {
        id: newUser._id,
        username: newUser.username,
        email: newUser.email
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: "Server error" });
  }
});

// Login endpoint
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: "Username and password are required" });
    }
    
    const user = await User.findOne({ username });
    
    if (!user) {
      return res.status(401).json({ message: "Invalid username or password" });
    }

    // Compare password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid username or password" });
    }

    // Generate JWT token
    const token = user.generateAuthToken();

    res.json({ 
      message: "Login successful", 
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: "Server error" });
  }
});

// Logout endpoint (client-side token removal)
app.post("/api/logout", auth, async (req, res) => {
  try {
    // In a more complex system, you might want to blacklist the token
    // For now, we'll just return success and let the client remove the token
    res.json({ message: "Logged out successfully" });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ message: "Server error" });
  }
});

// Verify token endpoint
app.get("/api/verify", auth, async (req, res) => {
  try {
    // If we reach here, the token is valid (auth middleware passed)
    res.json({ 
      message: "Token is valid",
      user: {
        id: req.user._id,
        username: req.user.username,
        email: req.user.email
      }
    });
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(500).json({ message: "Server error" });
  }
});

// Mount routes router
const routesRouter = require('./routes/routes');
app.use('/api/routes', routesRouter);

// ===== ROUTING ENDPOINTS =====

// Geocoding endpoint
app.post("/api/geocode", auth, async (req, res) => {
  try {
    const { cityName } = req.body;
    
    if (!cityName) {
      return res.status(400).json({ message: "City name is required" });
    }

    const apiKey = process.env.ORS_API_KEY 
    const url = `https://api.openrouteservice.org/geocode/search`;

    const response = await fetch(`${url}?api_key=${apiKey}&text=${encodeURIComponent(cityName)}`);
    const data = await response.json();

    if (!data.features || data.features.length === 0) {
      return res.status(404).json({ message: "Location not found" });
    }

    const [lon, lat] = data.features[0].geometry.coordinates;
    res.json({ coordinates: [lon, lat] });
  } catch (error) {
    console.error('Geocoding error:', error);
    res.status(500).json({ message: "Geocoding failed" });
  }
});

// Route generation endpoint
app.post("/api/routes/generate", auth, async (req, res) => {
  try {
    const { startCoords, endCoords, type = "cycling-regular", options = {} } = req.body;
    
    if (!startCoords || !endCoords) {
      return res.status(400).json({ message: "Start and end coordinates are required" });
    }

    const apiKey = process.env.ORS_API_KEY 
    
    // Validate routing profile
    const validTypes = ["cycling-regular", "foot-hiking", "driving-car", "driving-hgv"];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ message: "Invalid routing type" });
    }

    const url = `https://api.openrouteservice.org/v2/directions/${type}`;
    const coords = options?.round_trip ? [startCoords] : [startCoords, endCoords];

    const body = {
      coordinates: coords,
      options
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || err.message || "OpenRouteService request failed");
    }

    const data = await response.json();
    
    // Extract coordinates from response
    const encoded = data?.routes?.[0]?.geometry;
    let coordinates;

    if (typeof encoded === "string") {
      // Decode polyline
      const polyline = require('@mapbox/polyline');
      const decoded = polyline.decode(encoded);         // [[lat, lon], ...]
      coordinates = decoded.map(([lat, lon]) => [lon, lat]); // → [[lon, lat], ...]
    } else {
      const gj = data?.features?.[0]?.geometry?.coordinates;
      if (!gj || !Array.isArray(gj)) {
        throw new Error("No geometry found in ORS response");
      }
      coordinates = gj; // already [[lon, lat], ...]
    }

    res.json({ coordinates });
  } catch (error) {
    console.error('Route generation error:', error);
    res.status(500).json({ message: "Route generation failed", error: error.message });
  }
});

// Generate route endpoint (main entry point)
app.post("/api/generate-route", auth, async (req, res) => {
  try {
    const { destination, type } = req.body;
    
    if (!destination || !type) {
      return res.status(400).json({ message: "Destination and type are required" });
    }

    // 1) Geocode destination to [lon, lat]
    const [destLon, destLat] = await getCoordinatesORS(destination);

    let path = null;
    let pathDays = [];
    let lastError = null;

    // Try up to 3 times with different approaches
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`Route generation attempt ${attempt} for ${destination} (${type})`);
        
        if (type === 'hike') {
          // One call with ORS round_trip; loop between 5–15km
          const res = await getHikeLoopBetween5to15Km(destLon, destLat);
          path = res.coords;
          pathDays = [res.coords]; // single-day loop
        } else if (type === 'bike') {
          // Find a realistic 2-day route (start near destination), split ~60km/day
          const res = await getBikeTwoDaysNearDestination(destLon, destLat);
          path = res.coords;
          pathDays = res.days;
        } else {
          return res.status(400).json({ message: 'Unsupported type. Choose "hike" or "bike".' });
        }

        if (path && path.length >= 2) {
          console.log(`✅ Route generated successfully on attempt ${attempt}`);
          break; // Success!
        }
      } catch (error) {
        lastError = error;
        console.log(`❌ Attempt ${attempt} failed: ${error.message}`);
        
        if (attempt < 3) {
          // Wait a bit before retrying to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    if (!path || path.length < 2) {
      console.error('All route generation attempts failed');
      return res.status(500).json({ 
        message: lastError?.message || 'Could not generate route after 3 attempts. Please try a different destination or try again later.' 
      });
    }

    res.json({
      destination,
      type,
      path,       // [[lon,lat], ...]
      pathDays,   // [[[lon,lat], ...], ...]
    });
  } catch (error) {
    console.error('Generate route error:', error);
    res.status(500).json({ message: error.message || 'Failed to generate route. Please try again.' });
  }
});


// Haversine distance in KM for [lon,lat]
function segmentDistanceKm(a, b) {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const la1 = lat1 * Math.PI / 180;
  const la2 = lat2 * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function calculateRouteDistanceKm(coords) {
  if (!coords || coords.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += segmentDistanceKm(coords[i - 1], coords[i]);
  }
  return total;
}

// Split a single route into N days by target distance (greedy by cumulative length)
function splitRouteByDays(coordinates, days) {
  const total = calculateRouteDistanceKm(coordinates);
  if (days <= 1 || total === 0) return [coordinates];

  const targetPerDay = total / days;
  const result = [];
  let dayStartIdx = 0;
  let acc = 0;

  for (let i = 1; i < coordinates.length && result.length < days - 1; i++) {
    acc += segmentDistanceKm(coordinates[i - 1], coordinates[i]);
    if (acc >= targetPerDay) {
      result.push(coordinates.slice(dayStartIdx, i + 1));
      dayStartIdx = i;
      acc = 0;
    }
  }
  // last day
  if (dayStartIdx < coordinates.length - 1) {
    result.push(coordinates.slice(dayStartIdx));
  } else if (result.length < days) {
    result.push([coordinates[coordinates.length - 2], coordinates[coordinates.length - 1]]);
  }
  return result;
}

// Try a few loop lengths and pick the first that fits 5–15 km (one API call per try)
async function getHikeLoopBetween5to15Km(startLon, startLat) {
  const candidatesKm = [10, 12, 8, 14, 6, 5, 15]; // ordered by "likely to succeed"
  for (const lenKm of candidatesKm) {
    try {
      const coords = await getRoute(
        [startLon, startLat],
        null,
        'foot-hiking',
        { round_trip: { length: Math.round(lenKm * 1000), points: 3 } }
      );
      const d = calculateRouteDistanceKm(coords);
      if (d >= 5 && d <= 15) {
        return { coords, km: d };
      }
    } catch (e) {
      // try next length
    }
  }
  throw new Error('Could not generate a loop hike between 5–15 km. Try another location.');
}

// For bikes: we'll build a city-to-city route by picking a start near the destination
// with one request to ORS, then split into 2 days (~<=60km/day if possible).
// Strategy: use a small offset circle around destination and pick the first route under ~120km.
async function getBikeTwoDaysNearDestination(destLon, destLat) {
  // Bearings and offsets (km) to probe a start location near destination
  const bearings = [0, 90, 180, 270, 45, 135, 225, 315];
  const offsetsKm = [60, 45, 35, 25, 15]; // distance from destination to start

  const toLonLatOffset = (lon, lat, km, bearingDeg) => {
    // Simple equirectangular-ish offset (good enough for ~<100km)
    const R = 6371;
    const br = (bearingDeg * Math.PI) / 180;
    const dByR = km / R;
    const lat1 = (lat * Math.PI) / 180;
    const lon1 = (lon * Math.PI) / 180;

    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(dByR) + Math.cos(lat1) * Math.sin(dByR) * Math.cos(br)
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(br) * Math.sin(dByR) * Math.cos(lat1),
        Math.cos(dByR) - Math.sin(lat1) * Math.sin(lat2)
      );
    return [(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI];
  };

  for (const offset of offsetsKm) {
    for (const bearing of bearings) {
      const [startLon, startLat] = toLonLatOffset(destLon, destLat, offset, bearing);
      try {
        const coords = await getRoute([startLon, startLat], [destLon, destLat], 'cycling-regular');
        const totalKm = calculateRouteDistanceKm(coords);
        if (totalKm > 0) {
          // Split into 2 days by distance (aim ~half/half)
          const days = splitRouteByDays(coords, 2);
          const day1 = calculateRouteDistanceKm(days[0]);
          const day2 = calculateRouteDistanceKm(days[1]);
          if (day1 <= 60 + 5 && day2 <= 60 + 5) { // allow small tolerance
            return { coords, days, totalKm };
          }
          // If slightly over, still return first found; else keep searching
          if (totalKm <= 130) {
            return { coords, days, totalKm };
          }
        }
      } catch (e) {
        // try next probe
      }
    }
  }
  throw new Error('Could not find a two-day bike route near destination. Try another place.');
}

// Internal helper functions for the backend
async function getCoordinatesORS(cityName) {
  const apiKey = process.env.ORS_API_KEY
  const url = `https://api.openrouteservice.org/geocode/search`;

  const response = await fetch(`${url}?api_key=${apiKey}&text=${encodeURIComponent(cityName)}`);
  const data = await response.json();

  if (!data.features || data.features.length === 0) {
    throw new Error("Location not found");
  }

  const [lon, lat] = data.features[0].geometry.coordinates;
  return [lon, lat];
}

async function getRoute(startCoords, endCoords, type = "cycling-regular", options = {}) {
  const apiKey = process.env.ORS_API_KEY 

  // Validate routing profile
  const validTypes = ["cycling-regular", "foot-hiking", "driving-car", "driving-hgv"];
  if (!validTypes.includes(type)) {
    console.warn(`Invalid routing type: ${type}. Falling back to "cycling-regular".`);
    type = "cycling-regular";
  }

  const url = `https://api.openrouteservice.org/v2/directions/${type}`;

  // If round_trip is requested, ORS expects ONLY the start coordinate.
  const coords = options?.round_trip ? [startCoords] : [startCoords, endCoords];

  const body = {
    coordinates: coords,
    // DO NOT send radiuses here; not needed and can cause 4xx/instability.
    options
  };

  // Enhanced retry for 429/5xx with exponential backoff
  const doFetch = async (attempt = 1) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      
      // retry on rate-limit or server errors with exponential backoff
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // 1s, 2s, 4s max 5s
        console.log(`ORS rate limit/server error (${res.status}), retrying in ${delay}ms (attempt ${attempt}/3)`);
        await new Promise(r => setTimeout(r, delay));
        return doFetch(attempt + 1);
      }
      
      console.error("ORS error:", err);
      console.error("Request details:", { url, type, body });
      throw new Error("OpenRouteService request failed: " + (err.error?.message || err.message || "Unknown error"));
    }
    return res.json();
  };

  const data = await doFetch();

  // geometry may be an encoded polyline string (routes[0].geometry)
  // or GeoJSON (features[0].geometry.coordinates). Support both.
  const encoded = data?.routes?.[0]?.geometry;
  let coordinates;

  if (typeof encoded === "string") {
    const polyline = require('@mapbox/polyline');
    const decoded = polyline.decode(encoded);         // [[lat, lon], ...]
    coordinates = decoded.map(([lat, lon]) => [lon, lat]); // → [[lon, lat], ...]
  } else {
    const gj = data?.features?.[0]?.geometry?.coordinates;
    if (!gj || !Array.isArray(gj)) {
      throw new Error("No geometry found in ORS response");
    }
    coordinates = gj; // already [[lon, lat], ...]
  }

  return coordinates;
}

// LLM Enrichment endpoint
app.post("/api/llm/enrich", auth, async (req, res) => {
  try {
    const { destination, type, path, pathDays, weatherDaily } = req.body;
    
    if (!destination || !type || !path || !pathDays) {
      return res.status(400).json({ message: "Destination, type, path, and pathDays are required" });
    }

    // Get LLM API key
    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_API_KEY) {
      console.warn('Missing GROQ_API_KEY in server env');
      // Return fallback response instead of error
      return res.json({
        title: `${destination} ${type} route`,
        overview: `A ${type} route in ${destination}. Enjoy your adventure!`,
        bestWindows: [],
        segments: [],
        pois: [],
        safety_tips: [],
        gear_checklist: [],
        food_stops: [],
        photo_spots: []
      });
    }

    // Prepare route data for LLM
    const routeInfo = {
      destination,
      type,
      totalDays: pathDays.length,
      totalDistance: path.length > 1 ? calculateRouteDistanceKm(path) : 0,
      weather: weatherDaily || []
    };

         // Create LLM prompt - simplified and more direct
     const prompt = `Create a travel guide for a ${type} route in ${destination}. 

Route info: ${routeInfo.totalDays} days, ${routeInfo.totalDistance.toFixed(1)} km
${weatherDaily ? `Weather: ${JSON.stringify(weatherDaily)}` : ''}

IMPORTANT: Return ONLY valid JSON. Do not include any text before or after the JSON. No explanations, no "Here is the response:", nothing except the JSON object.

{
  "title": "Route title",
  "overview": "Brief description",
  "bestWindows": ["tip1", "tip2"],
  "segments": [{"name": "name", "description": "desc", "difficulty": "easy", "highlights": ["h1", "h2"]}],
  "pois": [{"name": "name", "type": "type", "description": "desc", "coordinates": [0, 0]}],
  "safety_tips": ["tip1", "tip2"],
  "gear_checklist": ["item1", "item2"],
  "food_stops": [{"name": "name", "type": "type", "description": "desc"}],
  "photo_spots": [{"name": "name", "description": "desc", "best_time": "time"}]
}`;

         // Call Groq LLM
     console.log('Calling Groq API with prompt:', prompt.substring(0, 200) + '...');
     
     const llmResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
       method: "POST",
       headers: {
         "Authorization": `Bearer ${GROQ_API_KEY}`,
         "Content-Type": "application/json",
       },
       body: JSON.stringify({
         model: "llama3-8b-8192",
         messages: [
           {
             role: "user",
             content: prompt
           }
         ],
         temperature: 0.7,
         max_tokens: 2000
       }),
     });

     console.log('LLM Response status:', llmResponse.status);
     
     if (!llmResponse.ok) {
       const errorText = await llmResponse.text();
       console.error('LLM API error:', llmResponse.status, llmResponse.statusText);
       console.error('Error response:', errorText);
       throw new Error('LLM service unavailable');
     }

     const llmData = await llmResponse.json();
     console.log('LLM Response data:', JSON.stringify(llmData, null, 2));
     
     const content = llmData.choices?.[0]?.message?.content;

     if (!content) {
       console.error('No content in LLM response');
       throw new Error('No content received from LLM');
     }

    // Parse JSON response - try to extract JSON if there's extra text
    let enrichment;
    try {
      enrichment = JSON.parse(content);
    } catch (parseError) {
      console.error('Failed to parse LLM JSON response:', parseError);
      console.error('Raw LLM response:', content);
      
      // Try to extract JSON from the response if it contains extra text
      try {
        // Look for JSON object in the response - more robust pattern
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          enrichment = JSON.parse(jsonMatch[0]);
          console.log('✅ Successfully extracted JSON from response with extra text');
        } else {
          // Try alternative patterns
          const altMatch = content.match(/```json\s*(\{[\s\S]*?\})\s*```/);
          if (altMatch) {
            enrichment = JSON.parse(altMatch[1]);
            console.log('✅ Successfully extracted JSON from code block');
          } else {
            // Try to find any JSON-like structure
            const lastBraceIndex = content.lastIndexOf('}');
            const firstBraceIndex = content.indexOf('{');
            if (firstBraceIndex !== -1 && lastBraceIndex !== -1 && lastBraceIndex > firstBraceIndex) {
              const jsonString = content.substring(firstBraceIndex, lastBraceIndex + 1);
              enrichment = JSON.parse(jsonString);
              console.log('✅ Successfully extracted JSON using brace matching');
            } else {
              throw new Error('No JSON object found in response');
            }
          }
        }
      } catch (extractError) {
        console.error('Failed to extract JSON from response:', extractError);
        throw new Error('Invalid JSON response from LLM');
      }
    }

    // Validate and sanitize the response
    const sanitizedEnrichment = {
      title: enrichment.title || `${destination} ${type} route`,
      overview: enrichment.overview || `A ${type} route in ${destination}. Enjoy your adventure!`,
      bestWindows: Array.isArray(enrichment.bestWindows) ? enrichment.bestWindows : [],
      segments: Array.isArray(enrichment.segments) ? enrichment.segments : [],
      pois: Array.isArray(enrichment.pois) ? enrichment.pois : [],
      safety_tips: Array.isArray(enrichment.safety_tips) ? enrichment.safety_tips : [],
      gear_checklist: Array.isArray(enrichment.gear_checklist) ? enrichment.gear_checklist : [],
      food_stops: Array.isArray(enrichment.food_stops) ? enrichment.food_stops : [],
      photo_spots: Array.isArray(enrichment.photo_spots) ? enrichment.photo_spots : []
    };

    res.json(sanitizedEnrichment);

  } catch (error) {
    console.error('LLM enrichment error:', error);
    
    // Return fallback response on any error
    res.json({
      title: `${req.body.destination || 'Route'} ${req.body.type || 'adventure'}`,
      overview: `A ${req.body.type || 'great'} route in ${req.body.destination || 'this area'}. Enjoy your adventure!`,
      bestWindows: [],
      segments: [],
      pois: [],
      safety_tips: [],
      gear_checklist: [],
      food_stops: [],
      photo_spots: []
    });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
