// CRO A8 drill: after a FAILED ACS import the target must be clean —
// no active contracts landed for the party (safe to restore + resume).
// The topology mapping (onboarding authorization from steps 3/6) is expected
// to exist at this point; the signal for "nothing half-landed" is the ACS.
// Params: -Dcro.party=<full party id>
import com.digitalasset.canton.topology.PartyId

val croPartyStr =
  sys.props.getOrElse("cro.party", { println("CRO_ERR -Dcro.party missing"); sys.exit(1); "" })
val croParty = PartyId.tryFromProtoPrimitive(croPartyStr)

val croAcs = participant2.ledger_api.state.acs.of_party(croParty)
println(s"CRO_VAR targetAcsCountAfterFail=${croAcs.size}")
if (croAcs.nonEmpty) {
  println("CRO_ERR target ACS NOT empty after failed import — do not blind-retry; investigate")
  sys.exit(1)
}
println("CRO_CLEAN_OK")
