# Automatic sync: proposed plan (not built)

Status: proposal only. Nothing in this file is built or tested.

## The problem
To sync automatically, the app must know two times for the same moment of the game:
1. When the TV shows the moment.
2. When the radio says the moment.

The camera can read the game clock on the TV. This gives time 1.
The radio stream has no game clock in it. Nothing gives time 2. This is the open problem.

## What we will not do
- We will not use the microphone. On iPhone, the microphone changes how the page plays sound. Tests showed bad sound when the microphone was on.
- We will not guess. Each step below has a test. If a test fails, we stop and report.

## Proposed steps

### Step 1: Read the TV game clock with the camera (test only)
- Use the back camera on a separate test page. Do not add it to the main page yet.
- Read the clock digits (for example "12:34") from the camera image with text recognition in the browser.
- Test: point the phone at a recorded game on a TV. Record how often the digits are correct, and how long each reading takes.
- Pass: correct digits on most frames, and a reading in less than 1 second.

### Step 2: Find the game clock on the radio side
This step decides if automatic sync is possible. Options, from best to worst:
- A. A live data feed with game events and their times (for example, a sports data service). Then compare the feed time with the radio time. Problem: these feeds cost money and have their own delay.
- B. Listen for spoken clock calls in the radio audio ("two minutes left in the half") with speech-to-text on the radio stream itself, not the microphone. Problem: the announcers do not say the clock often, and speech-to-text in the browser is heavy.
- C. Ask the user one time: "Tap when the radio says the snap." The camera then reads the TV clock at the next snap. This is half automatic. It still needs one tap.

Test for each option: use a recorded game with radio and TV. Measure the error in seconds. Pass: error less than 0.5 seconds.

### Step 3: Decide
- If option A or B passes, build automatic sync on a test page first.
- If only option C passes, show it as an optional helper. Pause / Resume stays the main method.
- If nothing passes, keep the manual method. It works now.

## What the owner must decide before we start
1. Is a paid data feed (option A) acceptable? This costs money every month.
2. Is the camera acceptable for users? The phone must point at the TV during sync.

## Current method (works now)
Pause the radio when the radio calls a play. Resume when the TV shows the same play. Then use Sooner or Later to fix small errors.
