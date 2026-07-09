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
