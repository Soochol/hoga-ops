module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'ticklane',
    icon: './assets/icon.png',
    // All runtime imports are Electron/Node built-ins. Ship only these assets.
    ignore: [/^\/(?!dist(?:\/|$)|assets(?:\/|$)|package\.json$|README\.md$)/],
  },
  makers: [
    { name: '@electron-forge/maker-zip', platforms: ['linux'] },
    { name: '@electron-forge/maker-deb', config: { options: {
      name: 'ticklane',
      bin: 'ticklane',
      productName: 'Ticklane',
      genericName: 'Ticklane',
      categories: ['Office', 'Finance'],
      maintainer: 'Hoga Ops contributors',
      homepage: 'https://github.com/Soochol/hoga-ops',
      icon: './assets/icon.png',
    } } },
  ],
};
