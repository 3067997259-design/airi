/**
 * Vehicle mover dispatch (MC-3b; CD-V1-V3 travel lifecycle).
 *
 * `elytra` and `strider` keep their dedicated movers. `boat`, `horse` and
 * `minecart` go through {@link runVehicleTravel}, the shared travel lifecycle
 * that owns acquisition, per-type driving, docking and the end-of-trip receipt.
 */
import type { VehicleKind, VehicleMoveOptions, VehicleMoveResult } from './vehicle-port'

import { runElytraMove } from './elytra'
import { runStriderMove } from './strider'
import { runVehicleTravel } from './vehicle-session'

export type {
  VehicleContext,
  VehicleControlPort,
  VehicleKind,
  VehicleMoveOptions,
  VehicleMoveResult,
  VehicleMoveStatus,
} from './vehicle-port'
export type {
  BoatVehicleState,
  CamelVehicleState,
  HorseVehicleState,
  MinecartVehicleState,
  VehicleAcquireStrategy,
  VehicleAssetReceipt,
  VehicleEntityKind,
  VehicleFailureReason,
  VehicleObservation,
  VehicleReceipt,
  VehicleTravelPhase,
  VehicleTypeState,
} from './vehicle-types'

/** Dispatches to the mover for one vehicle kind. */
export async function runVehicleMove(kind: VehicleKind, options: VehicleMoveOptions): Promise<VehicleMoveResult> {
  switch (kind) {
    case 'boat':
    case 'horse':
    case 'minecart':
      return await runVehicleTravel(kind, options)
    case 'elytra':
      return await runElytraMove(options)
    case 'strider':
      return await runStriderMove(options)
  }
}
