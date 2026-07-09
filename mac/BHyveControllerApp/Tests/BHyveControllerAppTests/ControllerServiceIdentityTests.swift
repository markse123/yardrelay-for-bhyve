import Foundation
import Testing
@testable import BHyveControllerApp

@Test func controllerProofIsBoundToProtocolV2AndExactOrigin() {
    let challenge = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    let token = "synthetic-test-token-that-is-not-a-credential"
    let origin = "http://127.0.0.1:3030"
    let proof = AppConfiguration.controllerProof(
        appToken: token,
        purpose: "identity",
        origin: origin,
        challenge: challenge)

    #expect(AppConfiguration.protocolVersion == 2)
    #expect(AppConfiguration.identityRequestTimeout == 2)
    #expect(AppConfiguration.maximumIdentityResponseBytes == 4096)
    #expect(proof == "kif3JIWzuxAv7He_GVysl3wDH0g3xmDttSW4J81JeQg")
    #expect(AppConfiguration.controllerProof(
        appToken: token,
        purpose: "shutdown",
        origin: origin,
        challenge: challenge) == "FNefke_xyoloN7WYWhxcbs3FK02GH69G7MPYF31vX-Q")
    #expect(proof != AppConfiguration.controllerProof(
        appToken: token,
        purpose: "identity",
        origin: "http://127.0.0.1:3031",
        challenge: challenge))
    #expect(proof != AppConfiguration.controllerProof(
        appToken: token,
        purpose: "shutdown",
        origin: origin,
        challenge: challenge))
}

@Test func controllerOriginRequiresTheConfiguredIPv4LoopbackEndpoint() {
    #expect(AppConfiguration.canonicalLoopbackOrigin(URL(string: "http://127.0.0.1:3030/")) == "http://127.0.0.1:3030")
    #expect(AppConfiguration.canonicalLoopbackOrigin(URL(string: "http://localhost:3030")) == nil)
    #expect(AppConfiguration.canonicalLoopbackOrigin(URL(string: "http://[::1]:3030")) == nil)
    #expect(AppConfiguration.canonicalLoopbackOrigin(URL(string: "https://127.0.0.1:3030")) == nil)
    #expect(AppConfiguration.canonicalLoopbackOrigin(URL(string: "http://127.0.0.1:3030/path")) == nil)
}

@Test func appTokenPolicyAcceptsOnlyTheSharedPrintableASCIIContract() {
    let minimumToken = "Ab1!" + String(repeating: "x", count: AppConfiguration.appTokenMinimumLength - 4)
    let maximumToken = "Ab1!" + String(repeating: "x", count: AppConfiguration.appTokenMaximumLength - 4)
    #expect(AppConfiguration.normalizedAppToken(minimumToken) == minimumToken)
    #expect(AppConfiguration.normalizedAppToken(maximumToken) == maximumToken)

    let rejectedTokens: [String?] = [
        nil,
        "",
        "x",
        "Ab1!" + String(repeating: "x", count: AppConfiguration.appTokenMinimumLength - 5),
        "Ab1!" + String(repeating: "x", count: AppConfiguration.appTokenMaximumLength - 3),
        "replace-with-a-long-random-local-token",
        "REPLACE-WITH-A-LONG-RANDOM-LOCAL-TOKEN",
        "password123456789012345678901234",
        "placeholder-12345678901234567890",
        "redacted-12345678901234567890123",
        " \(minimumToken)",
        "\(minimumToken) ",
        "synthetic-token-\u{1}-with-control-1234567890",
        "synthetic-token-\u{7f}-with-control-123456789",
        "synthetic-token-é-with-non-ascii-123456789",
    ]
    for token in rejectedTokens {
        #expect(AppConfiguration.normalizedAppToken(token) == nil)
    }
}

@Test func appTokenResolutionFailsClosedForExplicitUnsafeValues() {
    let safeToken = "Ab1!" + String(repeating: "x", count: AppConfiguration.appTokenMinimumLength - 4)
    var generatedCount = 0
    let rejectedEnvironment = AppConfiguration.resolveAppToken(
        environment: ["APP_TOKEN": "replace-with-a-long-random-local-token"],
        envContents: "APP_TOKEN=\(safeToken)",
        generateToken: {
            generatedCount += 1
            return safeToken
        })
    #expect(rejectedEnvironment.token == nil)
    #expect(rejectedEnvironment.errorMessage == AppConfiguration.appTokenRequirementsMessage)
    #expect(!rejectedEnvironment.generated)
    #expect(generatedCount == 0)

    let rejectedFile = AppConfiguration.resolveAppToken(
        environment: [:],
        envContents: "APP_TOKEN= \(safeToken)",
        generateToken: {
            generatedCount += 1
            return safeToken
        })
    #expect(rejectedFile.token == nil)
    #expect(rejectedFile.errorMessage == AppConfiguration.appTokenRequirementsMessage)
    #expect(generatedCount == 0)

    let generated = AppConfiguration.resolveAppToken(
        environment: [:],
        envContents: "ORBIT_EMAIL=synthetic@example.invalid",
        generateToken: {
            generatedCount += 1
            return String(repeating: "0123456789abcdef", count: 4)
        })
    #expect(generated.token == String(repeating: "0123456789abcdef", count: 4))
    #expect(generated.errorMessage == nil)
    #expect(generated.generated)
    #expect(generatedCount == 1)
}

@Test func browserTokenFragmentRequiresASafeToken() {
    let token = String(repeating: "0123456789abcdef", count: 4)
    #expect(AppConfiguration.browserURL(appToken: token)?.fragment == "token=\(token)")
    #expect(AppConfiguration.browserURL(appToken: "replace-with-a-long-random-local-token") == nil)
}
