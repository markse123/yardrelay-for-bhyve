// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "BHyveControllerApp",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "BHyveControllerApp", targets: ["BHyveControllerApp"]),
    ],
    targets: [
        .executableTarget(
            name: "BHyveControllerApp",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit"),
            ]
        ),
        .testTarget(
            name: "BHyveControllerAppTests",
            dependencies: ["BHyveControllerApp"]
        ),
    ]
)
