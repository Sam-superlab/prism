# iPhone installation path

The selected device is iPhone 15 Pro. The owner prefers Apple Developer membership and TestFlight. No signed iPhone binary has been produced or installed yet.

1. Enroll in the Apple Developer Program with the owner's Apple Account. Apple lists a USD 99 annual fee, or local currency where available. Account verification and payment must be completed by the owner: https://developer.apple.com/programs/enroll/
2. Prepare an Expo account and an EAS project for apps/mobile. EAS cloud builds can build iOS without installing full Xcode locally. For a local native build, install full Xcode and select its developer tools first.
3. Configure a backend HTTPS URL reachable from the iPhone, ending in /api/v1, plus the OIDC issuer, mobile public PKCE client and callback returned by /auth/config. Set EXPO_PUBLIC_API_URL in the EAS production environment. The phone's 127.0.0.1 is the phone itself, and the current Mac development listener is restricted to loopback; it is not a phone endpoint. A hosted backend allows use while the Mac is asleep.
4. Initialize the EAS project, confirm the bundle identifier and Apple team, then produce a production build and submit it to the owner's App Store Connect app. Complete credential prompts through the owner's authenticated session; never put passwords, tokens or verification codes in chat or source control.
5. Install Apple's TestFlight app on the iPhone, accept the testing invitation, and install the signed PRISM build. Validate sign-in, offline reviews/workouts, camera-independent file sharing, notifications and cross-device synchronization on the actual device.

Commands after account, identity and backend configuration (requires EAS CLI):

```sh
cd apps/mobile
eas login
eas init
eas build --platform ios --profile production
eas submit --platform ios --latest
```

The production profile bundles JavaScript and does not require Metro or a development terminal during use. Preview builds use registered-device ad-hoc distribution; TestFlight uses the production/store profile. Push delivery additionally needs the EAS project/APNs configuration. The app config rejects EAS release builds with a missing or loopback HTTP backend instead of generating an install that cannot connect.

Sources: https://docs.expo.dev/tutorial/eas/ios-development-build-for-devices/ ; https://docs.expo.dev/submit/ios/ ; https://developer.apple.com/help/account/basics/about-your-developer-account/ . Account enrollment and a reachable authenticated backend remain prerequisites, not completed work.
