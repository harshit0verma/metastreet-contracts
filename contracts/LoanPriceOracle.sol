// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.9;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "prb-math/contracts/PRBMathUD60x18.sol";

import "./interfaces/ILoanPriceOracle.sol";

/**
 * @title Loan Price Oracle
 */
contract LoanPriceOracle is AccessControl, ILoanPriceOracle {
    using EnumerableSet for EnumerableSet.AddressSet;

    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Implementation version
     */
    string public constant IMPLEMENTATION_VERSION = "1.0";

    /**
     * @notice One in UD60x18
     */
    uint256 private constant ONE_UD60X18 = 1e18;

    /**************************************************************************/
    /* Access Control Roles */
    /**************************************************************************/

    /**
     * @notice Parameter admin role
     */
    bytes32 public constant PARAMETER_ADMIN_ROLE = keccak256("PARAMETER_ADMIN");

    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Unsupported token decimals
     */
    error UnsupportedTokenDecimals();

    /**
     * @notice Invalid address (e.g. zero address)
     */
    error InvalidAddress();

    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @notice Emitted when minimum loan duration is updated
     * @param duration New minimum loan duration in seconds
     */
    event MinimumLoanDurationUpdated(uint256 duration);

    /**
     * @notice Emitted when collateral parameters are updated
     * @param collateralToken Address of collateral token
     */
    event CollateralParametersUpdated(address indexed collateralToken);

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Piecewise linear model parameters
     * @param offset Output value offset in UD60x18
     * @param slope1 Slope before kink in UD60x18
     * @param slope2 Slope after kink in UD60x18
     * @param target Input value of kink in UD60x18
     * @param max Max input value in UD60x18
     */
    struct PiecewiseLinearModel {
        uint256 offset;
        uint256 slope1;
        uint256 slope2;
        uint256 target;
        uint256 max;
    }

    /**
     * @notice Collateral parameters
     * @param collateralValue Collateral value in UD60x18
     * @param utilizationRateComponent Rate component model for utilization
     * @param loanToValueRateComponent Rate component model for loan to value
     * @param durationRateComponent Rate component model for duration
     * @param rateComponentWeights Weights for rate components, each 0 to 10000
     */
    struct CollateralParameters {
        uint256 collateralValue; /* UD60x18 */
        PiecewiseLinearModel utilizationRateComponent;
        PiecewiseLinearModel loanToValueRateComponent;
        PiecewiseLinearModel durationRateComponent;
        uint16[3] rateComponentWeights; /* 0-10000 */
    }

    /**
     * @dev Mapping of collateral token contract to collateral parameters
     */
    mapping(address => CollateralParameters) private _parameters;

    /**
     * @dev Set of supported collateral tokens
     */
    EnumerableSet.AddressSet private _collateralTokens;

    /**
     * @inheritdoc ILoanPriceOracle
     */
    IERC20 public immutable override currencyToken;

    /**
     * @notice Minimum loan duration in seconds
     */
    uint256 public minimumLoanDuration;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice LoanPriceOracle constructor
     * @param currencyToken_ Currency token used for pricing
     */
    constructor(IERC20 currencyToken_) {
        if (IERC20Metadata(address(currencyToken_)).decimals() != 18) revert UnsupportedTokenDecimals();

        currencyToken = currencyToken_;

        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(PARAMETER_ADMIN_ROLE, msg.sender);
    }

    /**************************************************************************/
    /* Internal Helper Functions */
    /**************************************************************************/

    /**
     * @dev Compute the output of the specified piecewise linear model with
     * input x
     * @param model Piecewise linear model to compute
     * @param x Input value in UD60x18
     * @param index Parameter index (for error reporting)
     * @return Result in UD60x18
     */
    function _computeRateComponent(
        PiecewiseLinearModel storage model,
        uint256 x,
        uint256 index
    ) internal view returns (uint256) {
        if (x > model.max) {
            revert ParameterOutOfBounds(index);
        }
        return
            (x <= model.target)
                ? model.offset + PRBMathUD60x18.mul(x, model.slope1)
                : model.offset +
                    PRBMathUD60x18.mul(model.target, model.slope1) +
                    PRBMathUD60x18.mul(x - model.target, model.slope2);
    }

    /**
     * @dev Compute the weighted rate
     * @param weights Weights to apply, each 0 to 10000
     * @param components Components to weight, each UD60x18
     * @return Weighted rate in UD60x18
     */
    function _computeWeightedRate(uint16[3] storage weights, uint256[3] memory components)
        internal
        view
        returns (uint256)
    {
        return
            PRBMathUD60x18.div(
                PRBMathUD60x18.mul(components[0], PRBMathUD60x18.fromUint(weights[0])) +
                    PRBMathUD60x18.mul(components[1], PRBMathUD60x18.fromUint(weights[1])) +
                    PRBMathUD60x18.mul(components[2], PRBMathUD60x18.fromUint(weights[2])),
                PRBMathUD60x18.fromUint(10000)
            );
    }

    /**************************************************************************/
    /* Primary API */
    /**************************************************************************/

    /**
     * @inheritdoc ILoanPriceOracle
     */
    function priceLoan(
        address collateralToken,
        uint256 collateralTokenId,
        uint256 principal,
        uint256 repayment,
        uint256 duration,
        uint256 maturity,
        uint256 utilization
    ) external view returns (uint256) {
        /* Unused variables */
        collateralTokenId;
        duration;

        /* Validate minimum loan duration */
        if (block.timestamp > maturity - minimumLoanDuration) {
            revert InsufficientTimeRemaining();
        }

        /* Look up collateral parameters */
        CollateralParameters storage collateralParameters = _parameters[collateralToken];
        if (collateralParameters.collateralValue == 0) {
            revert UnsupportedCollateral();
        }

        /* Calculate loan time remaining */
        uint256 loanTimeRemaining = PRBMathUD60x18.fromUint(maturity - block.timestamp);

        /* Calculate loan to value */
        uint256 loanToValue = PRBMathUD60x18.div(principal, collateralParameters.collateralValue);

        /* Compute discount rate components for utilization, loan-to-value, and duration */
        uint256[3] memory rateComponents = [
            _computeRateComponent(collateralParameters.utilizationRateComponent, utilization, 0),
            _computeRateComponent(collateralParameters.loanToValueRateComponent, loanToValue, 1),
            _computeRateComponent(collateralParameters.durationRateComponent, loanTimeRemaining, 2)
        ];

        /* Calculate discount rate from components */
        uint256 discountRate = _computeWeightedRate(collateralParameters.rateComponentWeights, rateComponents);

        /* Calculate purchase price */
        /* Purchase Price = Loan Repayment Value / (1 + Discount Rate * t) */
        uint256 purchasePrice = PRBMathUD60x18.div(
            repayment,
            ONE_UD60X18 + PRBMathUD60x18.mul(discountRate, loanTimeRemaining)
        );

        return purchasePrice;
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @notice Get collateral parameters for token contract
     * @param collateralToken Collateral token contract
     * @return Collateral parameters
     */
    function getCollateralParameters(address collateralToken) external view returns (CollateralParameters memory) {
        return _parameters[collateralToken];
    }

    /**
     * @notice Get list of supported collateral tokens
     * @return List of collateral token addresses
     */
    function supportedCollateralTokens() external view returns (address[] memory) {
        return _collateralTokens.values();
    }

    /**************************************************************************/
    /* Setters */
    /**************************************************************************/

    /**
     * @notice Set minimum loan duration
     *
     * Emits a {MinimumLoanDurationUpdated} event.
     *
     * @param duration Minimum loan duration in seconds
     */
    function setMinimumLoanDuration(uint256 duration) external onlyRole(PARAMETER_ADMIN_ROLE) {
        minimumLoanDuration = duration;

        emit MinimumLoanDurationUpdated(duration);
    }

    /**
     * @notice Set collateral parameters
     *
     * Emits a {CollateralParametersUpdated} event.
     *
     * @param collateralToken Collateral token contract
     * @param packedCollateralParameters Collateral parameters, ABI-encoded
     */
    function setCollateralParameters(address collateralToken, bytes calldata packedCollateralParameters)
        external
        onlyRole(PARAMETER_ADMIN_ROLE)
    {
        if (collateralToken == address(0)) revert InvalidAddress();

        _parameters[collateralToken] = abi.decode(packedCollateralParameters, (CollateralParameters));

        /* Validate rate component weights sum to 10000 */
        if (
            _parameters[collateralToken].rateComponentWeights[0] +
                _parameters[collateralToken].rateComponentWeights[1] +
                _parameters[collateralToken].rateComponentWeights[2] !=
            10000
        ) revert ParameterOutOfBounds(4);

        if (_parameters[collateralToken].collateralValue != 0) {
            _collateralTokens.add(collateralToken);
        } else {
            _collateralTokens.remove(collateralToken);
        }

        emit CollateralParametersUpdated(collateralToken);
    }
}
