# PRISM 0.2 appearance update

The Mac/Web interface, iOS interface, native desktop menus, and new system-generated planner/notification text now use English. Existing profile names, notes, projects, saved history and offline operations retain their original content and language.

The visual system uses native system typography, cool neutral surfaces, blue interaction accents, subtle borders and shadows, and the same faceted prism mark across the desktop icon, iOS icon, sidebar and Web metadata. Canonical SVG assets live in assets/. scripts/generate-icons.mjs produces the macOS ICNS family, an opaque 1024-pixel iOS PNG and Web icons. The Mac build installs the icon resource and supplies it to the Dock.

Mac/Web Settings → Appearance supports automatic/light/dark themes, text sizes from 13 to 20 px, system/serif reading typography, comfortable/compact density, blue/indigo/teal accents, standard/increased contrast, reduced motion, and translucent surfaces. Values are validated and stored in the device's WebKit/browser localStorage, applied before first paint, synchronized between tabs on that device, and resettable. These are local presentation settings rather than server-side account preferences. The Mac titlebar follows explicit app theme selection.

iOS Settings supports persistent system/light/dark appearance, four text sizes, and reduced motion through local SQLite metadata. Native accessibility font scaling remains enabled; system reduced-motion preference is honored. The UI and math renderer use the selected scale. These settings do not modify user records or the synchronization outbox.

Route entrances, dialogs, task/paper entries, progress updates, navigation drawers and button/card interactions have brief transitions. OS or app reduced-motion preferences minimize them. Entrance content remains visible even while WebKit defers animation frames; colors are explicit on surfaces so native macOS appearance changes remain consistent. Developer status indicators are hidden from the personal desktop interface; error diagnostics remain available.

Validation is recorded in ../verification/appearance-redesign.json and e2e-final.json. Native Mac checks include startup, English navigation, Settings and automatic/light/dark rendering. iOS type checks, SQLite tests and Hermes export pass; signed iPhone installation and actual-device visual/VoiceOver acceptance remain part of the separate TestFlight work. The desktop remains the documented personal local build requiring this project directory and runtime.
